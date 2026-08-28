// A small VT/ANSI screen emulator.
//
// A ConPTY does not simply forward what a program wrote: it repaints a console
// screen, so blank lines arrive as cursor moves rather than as newlines, and
// erases arrive as CSI sequences. Stripping those escapes would silently glue
// unrelated lines together. Replaying them onto a character grid reproduces
// exactly the screen a human would have been looking at.
//
// Only the subset a plain, append-only CLI can produce is implemented.

const ESC = "\u001b";

export function renderScreen(raw, cols = 100, rows = 60) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  let row = 0;
  let col = 0;

  const scroll = () => {
    grid.shift();
    grid.push(new Array(cols).fill(" "));
  };
  const clampRow = () => {
    while (row >= rows) {
      scroll();
      row -= 1;
    }
    if (row < 0) row = 0;
  };
  const put = (ch) => {
    if (col >= cols) {
      col = 0;
      row += 1;
      clampRow();
    }
    grid[row][col] = ch;
    col += 1;
  };
  const eraseInLine = (mode) => {
    const from = mode === 1 ? 0 : mode === 2 ? 0 : col;
    const to = mode === 1 ? Math.min(col + 1, cols) : cols;
    for (let i = from; i < to; i += 1) grid[row][i] = " ";
  };
  const eraseInDisplay = (mode) => {
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < rows; r += 1) grid[r].fill(" ");
      return;
    }
    if (mode === 1) {
      for (let r = 0; r < row; r += 1) grid[r].fill(" ");
      eraseInLine(1);
      return;
    }
    eraseInLine(0);
    for (let r = row + 1; r < rows; r += 1) grid[r].fill(" ");
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === ESC) {
      const next = raw[i + 1];

      if (next === "[") {
        let j = i + 2;
        while (j < raw.length && raw[j] >= " " && raw[j] <= "?") j += 1;
        const params = raw.slice(i + 2, j);
        const final = raw[j];
        i = j + 1;
        if (params.startsWith("?")) continue; // DECSET/DECRST: display modes only

        const nums = params
          .split(";")
          .map((part) => (part === "" ? null : Number.parseInt(part, 10)))
          .map((value) => (Number.isNaN(value) ? null : value));
        const n = nums[0] ?? 1;

        switch (final) {
          case "H":
          case "f":
            row = (nums[0] ?? 1) - 1;
            col = (nums[1] ?? 1) - 1;
            if (row < 0) row = 0;
            if (col < 0) col = 0;
            clampRow();
            break;
          case "A":
            row = Math.max(0, row - n);
            break;
          case "B":
            row += n;
            clampRow();
            break;
          case "C":
            col = Math.min(cols - 1, col + n);
            break;
          case "D":
            col = Math.max(0, col - n);
            break;
          case "E":
            row += n;
            col = 0;
            clampRow();
            break;
          case "F":
            row = Math.max(0, row - n);
            col = 0;
            break;
          case "G":
            col = Math.max(0, (nums[0] ?? 1) - 1);
            break;
          case "J":
            eraseInDisplay(nums[0] ?? 0);
            break;
          case "K":
            eraseInLine(nums[0] ?? 0);
            break;
          case "X":
            for (let k = col; k < Math.min(cols, col + n); k += 1) grid[row][k] = " ";
            break;
          case "P":
            grid[row].splice(col, n);
            while (grid[row].length < cols) grid[row].push(" ");
            break;
          case "@":
            for (let k = 0; k < n; k += 1) grid[row].splice(col, 0, " ");
            grid[row].length = cols;
            break;
          case "L":
            for (let k = 0; k < n; k += 1) {
              grid.splice(row, 0, new Array(cols).fill(" "));
              grid.length = rows;
            }
            break;
          case "M":
            for (let k = 0; k < n; k += 1) {
              grid.splice(row, 1);
              grid.push(new Array(cols).fill(" "));
            }
            break;
          default:
            break; // SGR and friends carry no text
        }
        continue;
      }

      if (next === "]") {
        // OSC ... BEL | ESC backslash
        let j = i + 2;
        while (j < raw.length) {
          if (raw[j] === "\u0007") {
            j += 1;
            break;
          }
          if (raw[j] === ESC && raw[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }

      if (next === "(" || next === ")" || next === "#") {
        i += 3;
        continue;
      }

      i += 2;
      continue;
    }

    if (ch === "\n") {
      row += 1;
      col = 0;
      clampRow();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }
    if (ch === "\t") {
      const stop = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
      while (col < stop) put(" ");
      i += 1;
      continue;
    }
    if (ch < " " && ch !== " ") {
      i += 1;
      continue;
    }

    put(ch);
    i += 1;
  }

  const lines = grid.map((line) => line.join("").replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Drops the blank rows a console can paint above the program's first output.
export function trimLeadingBlank(lines) {
  const out = [...lines];
  while (out.length > 0 && out[0] === "") out.shift();
  return out;
}
