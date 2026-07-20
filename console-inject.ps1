# Perch console inject - types text INTO a specific session's console input
# buffer via WriteConsoleInput. No window focus, no SendKeys, no tab switch:
# we attach by PID (deterministic - typing into the wrong app is impossible)
# and the target reads the keystrokes exactly as if a human typed them, even
# while the tab is unfocused or the window is minimized.
#
# Runs in a DISPOSABLE child process (same law as console-probe: console RPC
# can hang forever on a hosed conhost; the parent enforces a timeout).
# Inline Add-Type is fine HERE: injection is a manual user action, not a
# polling loop - one C# compile per click costs nothing that matters.
#
# exit 0 = delivered | 2 = attach failed | 3 = CONIN open failed | 4 = write failed
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Text = '/compact',
    [switch]$Enter
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Perch {
    public static class Inject {
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

        [StructLayout(LayoutKind.Explicit)]
        public struct KEY_EVENT_RECORD {
            [FieldOffset(0)] public int bKeyDown;
            [FieldOffset(4)] public ushort wRepeatCount;
            [FieldOffset(6)] public ushort wVirtualKeyCode;
            [FieldOffset(8)] public ushort wVirtualScanCode;
            [FieldOffset(10)] public char UnicodeChar;
            [FieldOffset(12)] public uint dwControlKeyState;
        }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUT_RECORD {
            [FieldOffset(0)] public ushort EventType;
            [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
        }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint count, out uint written);

        static INPUT_RECORD[] Make(char c, ushort vk) {
            INPUT_RECORD down = new INPUT_RECORD();
            down.EventType = 1; // KEY_EVENT
            down.KeyEvent.bKeyDown = 1;
            down.KeyEvent.wRepeatCount = 1;
            down.KeyEvent.wVirtualKeyCode = vk;
            down.KeyEvent.wVirtualScanCode = 0;
            down.KeyEvent.UnicodeChar = c;
            down.KeyEvent.dwControlKeyState = 0;
            INPUT_RECORD up = down;
            up.KeyEvent.bKeyDown = 0;
            return new INPUT_RECORD[] { down, up };
        }

        static bool Send(IntPtr h, string text) {
            foreach (char c in text) {
                INPUT_RECORD[] recs = Make(c, 0);
                uint w;
                if (!WriteConsoleInputW(h, recs, (uint)recs.Length, out w)) return false;
            }
            return true;
        }

        public static int TypeText(uint pid, string text, bool enter, int settleMs) {
            FreeConsole();
            if (!AttachConsole(pid)) return 2;
            try {
                // 0xC0000000 = GENERIC_READ|GENERIC_WRITE, share 3, OPEN_EXISTING
                IntPtr h = CreateFileW("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
                if (h == IntPtr.Zero || h.ToInt64() == -1) return 3;
                try {
                    if (!Send(h, text)) return 4;
                    if (enter) {
                        // let the target's slash-command menu settle on the
                        // exact match before the Enter lands (mirrors a human)
                        System.Threading.Thread.Sleep(settleMs);
                        INPUT_RECORD[] cr = Make('\r', 13);
                        uint w;
                        if (!WriteConsoleInputW(h, cr, (uint)cr.Length, out w)) return 4;
                    }
                    return 0;
                } finally { CloseHandle(h); }
            } finally { FreeConsole(); }
        }
    }
}
"@

exit ([Perch.Inject]::TypeText([uint32]$TargetPid, $Text, [bool]$Enter, 220))
