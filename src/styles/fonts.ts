// bundled variable fonts (geist + geist mono), imported once and shared by every
// window entry. bundling keeps the desktop app fully offline and renders paths /
// keycaps in the designed mono on the first frame instead of system monospace.
// explicit /index.css paths so tsc resolves them like any other stylesheet import.
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
