#!/usr/bin/env python3
"""Drive an interactive api-key-case command under a real pty.

Why this exists: packages/cli/prompt.ts refuses to read a secret value or a
production confirmation from anything that is not a TTY, and AGENTS.md
section 3 forbids adding a bypass ("there is no flag to skip this").  So the
end-to-end job must not reach for a --stdin escape hatch; it has to type into
a real terminal the way a human does.  This allocates a pty, waits for each
prompt to actually appear, and types the answer.

Secret material is passed by environment variable name, never on argv, and is
masked out of both the printed transcript and the transcript file.  Literal
step answers ("yes") are deliberately NOT masked: they are not secrets, and
masking such common words would corrupt the transcript the caller asserts on.

Usage:
  pty-drive.py --step 'PATTERN=>env:VARNAME' \
               --step 'PATTERN=>literal:yes' \
               [--mask-env VARNAME] [--transcript FILE] [--timeout SECONDS] \
               -- command arg...

Exit status:
  the child's exit status, or
  97  a --step pattern never appeared before the child exited
  98  the overall timeout elapsed
"""

import argparse
import errno
import os
import pty
import re
import select
import subprocess
import sys
import termios
import time

# Once the child is gone, keep draining the pty briefly so the last lines it
# wrote before exiting still make it into the transcript.
DRAIN_SECONDS = 2.0


def parse_step(raw):
    """'PATTERN=>env:NAME' or 'PATTERN=>literal:TEXT' -> (compiled, text, secret)."""
    if "=>" not in raw:
        raise argparse.ArgumentTypeError(f"--step needs PATTERN=>SOURCE:VALUE, got {raw!r}")
    pattern, source = raw.split("=>", 1)
    if source.startswith("env:"):
        name = source[len("env:"):]
        value = os.environ.get(name)
        if not value:
            raise argparse.ArgumentTypeError(f"--step referenced env {name}, which is unset or empty")
        secret = True
    elif source.startswith("literal:"):
        value = source[len("literal:"):]
        secret = False
    else:
        raise argparse.ArgumentTypeError(f"--step source must be env: or literal:, got {source!r}")
    return re.compile(pattern), value, secret


def mask(text, secrets):
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***MASKED***")
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", action="append", default=[], type=parse_step)
    parser.add_argument("--mask-env", action="append", default=[])
    parser.add_argument("--transcript")
    # Unmasked copy, for the caller's leak assertion. Grepping the masked
    # transcript would be circular: the mask would hide the very leak the
    # check exists to find. Callers must delete it and must never print it.
    parser.add_argument("--raw-transcript")
    parser.add_argument("--timeout", type=float, default=240.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        parser.error("no command given (put it after --)")

    secrets = [os.environ.get(name, "") for name in args.mask_env]
    secrets += [value for _pattern, value, is_secret in args.step if is_secret]

    master_fd, slave_fd = pty.openpty()

    # Turn the terminal's own echo off before the child starts.
    #
    # A pty's line discipline echoes whatever is typed at it straight back into
    # the transcript. For a human that never matters here: prompt.ts prints the
    # prompt and only then calls readHiddenLine(), which switches the tty to raw
    # mode (echo off), and a person takes far longer to reach for a key than
    # that takes. This harness answers within microseconds of seeing the prompt,
    # so it wins that race and its own keystrokes land in the transcript --
    # which the leak check would then report as the product having printed the
    # secret. Disabling echo up front removes the artifact without hiding
    # anything real: the CLI's own writes are unaffected, and node's readline
    # renders the confirmation answer itself rather than relying on tty echo.
    attributes = termios.tcgetattr(slave_fd)
    attributes[3] &= ~termios.ECHO  # lflag
    termios.tcsetattr(slave_fd, termios.TCSANOW, attributes)

    child = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    transcript = ""
    # Only text seen since the last answer is matched, so one prompt cannot be
    # satisfied twice by text still sitting in the buffer.
    pending = ""
    steps = list(args.step)
    deadline = time.monotonic() + args.timeout
    drain_until = None
    timed_out = False

    try:
        while True:
            now = time.monotonic()
            if now > deadline:
                timed_out = True
                child.kill()
                break
            if drain_until is not None and now > drain_until:
                break

            try:
                ready, _, _ = select.select([master_fd], [], [], 0.25)
            except (OSError, ValueError):
                break

            if not ready:
                if drain_until is None and child.poll() is not None:
                    drain_until = time.monotonic() + DRAIN_SECONDS
                continue

            try:
                chunk = os.read(master_fd, 4096)
            except OSError as err:
                # The child closed the pty: normal end of stream on macOS/Linux.
                if err.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not chunk:
                break

            text = chunk.decode("utf-8", "replace")
            transcript += text
            pending += text

            if steps and steps[0][0].search(pending):
                _pattern, value, _secret = steps.pop(0)
                os.write(master_fd, (value + "\r").encode("utf-8"))
                pending = ""
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    exit_code = child.wait()
    masked = mask(transcript, secrets)

    if args.transcript:
        with open(args.transcript, "w", encoding="utf-8") as handle:
            handle.write(masked)

    if args.raw_transcript:
        fd = os.open(args.raw_transcript, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(transcript)

    sys.stdout.write(masked)
    if not masked.endswith("\n"):
        sys.stdout.write("\n")
    sys.stdout.flush()

    if timed_out:
        sys.stderr.write(f"pty-drive: timed out after {args.timeout}s\n")
        return 98
    if steps:
        missing = ", ".join(pattern.pattern for pattern, _value, _secret in steps)
        sys.stderr.write(f"pty-drive: child exited before these prompts appeared: {missing}\n")
        return 97
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
