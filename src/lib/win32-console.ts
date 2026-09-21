/**
 * Windows Console Window Self-Hiding Utility.
 * 
 * When ACP stdio servers are launched on Windows by a GUI host (Zed, Electron, etc.),
 * Windows kernel automatically allocates a visible conhost console window because
 * Node/Bun are console subsystem binaries.
 * 
 * Calling `hideConsoleWindow()` as early as possible in the server entry point
 * immediately hides and detaches the console window via Win32 API, while keeping
 * stdio pipes (pipe handles) 100% intact and functional.
 */
export function hideConsoleWindow(): void {
  if (process.platform !== 'win32') return;

  // Bun runtime: use bun:ffi for zero-dependency native Win32 API calls
  if ((process as any).versions?.bun) {
    try {
      // Dynamic require to prevent bundler errors when compiling for Node
      const ffiMod = 'bun' + ':ffi';
      const { dlopen, FFIType } = require(ffiMod);
      const kernel32 = dlopen('kernel32.dll', {
        GetConsoleWindow: { args: [], returns: FFIType.ptr },
        FreeConsole: { args: [], returns: FFIType.bool },
      });
      const user32 = dlopen('user32.dll', {
        ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
      });

      const hwnd = kernel32.symbols.GetConsoleWindow();
      if (hwnd) {
        user32.symbols.ShowWindow(hwnd, 0); // 0 = SW_HIDE
      }
      kernel32.symbols.FreeConsole();
    } catch {
      // Fallback: ignore if FFI is unsupported or already detached
    }
  }
}
