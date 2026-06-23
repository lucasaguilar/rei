import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Clipboard image grab (Phase 2, cross-platform).
 *
 * A terminal can't receive raw image bytes on paste (Cmd/Ctrl+V yields text only), so to
 * support "paste a screenshot like in a GUI chat" we read the OS clipboard directly and
 * write any image it holds to a temp PNG. The vision sidecar then processes that file
 * exactly like a dragged-in image path.
 *
 * Backends:
 * - macOS:   AppleScript (`osascript`, «class PNGf»)         — built in
 * - Windows: PowerShell (System.Windows.Forms.Clipboard)     — built in
 * - Linux:   `wl-paste` (Wayland) or `xclip` (X11)           — must be installed
 */

export interface ClipboardImageResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

// Generous cap: clipboard screenshots can be several MB at retina resolution.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** AppleScript that writes the clipboard PNG to `target`, or returns "NO_IMAGE". */
function macScript(target: string): string {
  return [
    `set theFile to (POSIX file "${target}")`,
    `try`,
    `  set theData to (the clipboard as «class PNGf»)`,
    `on error`,
    `  return "NO_IMAGE"`,
    `end try`,
    `set fp to open for access theFile with write permission`,
    `set eof fp to 0`,
    `write theData to fp`,
    `close access fp`,
    `return "OK"`,
  ].join("\n");
}

/** PowerShell that saves the clipboard image to `target` as PNG, or prints "NO_IMAGE". */
function windowsScript(target: string): string {
  const escaped = target.replace(/'/g, "''");
  return [
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    `$img = [System.Windows.Forms.Clipboard]::GetImage()`,
    `if ($img -eq $null) { 'NO_IMAGE' }`,
    `else { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' }`,
  ].join("; ");
}

function ok(target: string): ClipboardImageResult {
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    return { ok: false, error: "Clipboard image could not be written." };
  }
  if (size === 0) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, error: "Clipboard image was empty." };
  }
  return { ok: true, filePath: target };
}

const NO_IMAGE: ClipboardImageResult = {
  ok: false,
  error: "No image found in the clipboard. Copy a screenshot or image first.",
};

async function grabMac(target: string): Promise<ClipboardImageResult> {
  const { stdout } = await execFileAsync("osascript", ["-e", macScript(target)]);
  const out = stdout.trim();
  if (out === "NO_IMAGE") return NO_IMAGE;
  if (out !== "OK") return { ok: false, error: `Unexpected clipboard result: ${out}` };
  return ok(target);
}

async function grabWindows(target: string): Promise<ClipboardImageResult> {
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsScript(target),
  ]);
  if (stdout.includes("NO_IMAGE")) return NO_IMAGE;
  return ok(target);
}

/**
 * Linux: capture the clipboard image bytes from a tool's stdout and write them to disk.
 * stdout is binary, so we read it as a Buffer (not utf-8) to avoid corruption.
 */
async function grabLinuxWith(
  cmd: string,
  args: string[],
  target: string,
): Promise<ClipboardImageResult> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: "buffer",
    maxBuffer: MAX_IMAGE_BYTES,
  });
  const buf = stdout as unknown as Buffer;
  if (!buf || buf.length === 0) return NO_IMAGE;
  fs.writeFileSync(target, buf);
  return ok(target);
}

async function grabLinux(target: string): Promise<ClipboardImageResult> {
  // Prefer Wayland when its session is present, else X11. Try the other on failure.
  const wayland = !!process.env.WAYLAND_DISPLAY;
  const attempts: Array<[string, string[]]> = wayland
    ? [
        ["wl-paste", ["--type", "image/png"]],
        ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
      ]
    : [
        ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
        ["wl-paste", ["--type", "image/png"]],
      ];

  let lastErr = "";
  for (const [cmd, args] of attempts) {
    try {
      return await grabLinuxWith(cmd, args, target);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // ENOENT → tool not installed; try the next backend.
    }
  }
  return {
    ok: false,
    error:
      "Could not read the clipboard. Install 'wl-clipboard' (Wayland) or 'xclip' (X11). " +
      `Last error: ${lastErr}`,
  };
}

/**
 * Reads an image from the system clipboard and writes it to a temp PNG file.
 * Returns a structured result instead of throwing so callers can show a friendly
 * message. The caller owns the temp file (delete it when done).
 */
export async function grabClipboardImage(): Promise<ClipboardImageResult> {
  const target = path.join(os.tmpdir(), `rei-clip-${Date.now()}.png`);
  try {
    switch (process.platform) {
      case "darwin":
        return await grabMac(target);
      case "win32":
        return await grabWindows(target);
      case "linux":
        return await grabLinux(target);
      default:
        return {
          ok: false,
          error: `Clipboard image paste is not supported on this platform (${process.platform}). You can still drag a file or type its path.`,
        };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
