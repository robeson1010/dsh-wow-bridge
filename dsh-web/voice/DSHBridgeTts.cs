// DSH Bridge silent "voice": a SAPI 5 text-to-speech engine that makes no sound.
// When WoW reads text aloud with this voice (C_VoiceChat.SpeakText), the text is
// pushed straight to the bridge over the named pipe \\.\pipe\DSHBridge. When the
// bridge is not running (no pipe within 100 ms), it is written to
// %APPDATA%\DSHBridge\tts-inbox\*.txt instead, which the bridge reads on start.
//
// Adapted from Forever AI Companion's ForeverAICompanionTts.cs
// (https://github.com/lucasmenares/forever-ai-companion, MIT License,
// Copyright (c) Forever AI Companion contributors). See ../THIRD_PARTY_NOTICES.md.
//
// Build (csc ships with Windows, .NET Framework 4):
//   csc /target:library /out:DSHBridgeTts.dll DSHBridgeTts.cs
// Registration: see install-voice.ps1.
//
// Safety, as in the original:
//  - only DSH Bridge messages are kept ("DSHB:..." frames and the voice test);
//    any other text is dropped and never written or logged;
//  - nothing is written through a junction or symlink planted in the data folder.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace DSHBridge.Tts
{
    [ComImport, Guid("5B559F40-E952-11D2-BB91-00C04F8EE6C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpObjectWithToken
    {
        [PreserveSig] int SetObjectToken(IntPtr pToken);
        [PreserveSig] int GetObjectToken(out IntPtr ppToken);
    }

    [ComImport, Guid("A74D7C8E-4CC5-4F2F-A6EB-804DEE18500E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpTTSEngine
    {
        [PreserveSig] int Speak(uint dwSpeakFlags, ref Guid rguidFormatId, IntPtr pWaveFormatEx, IntPtr pTextFragList, IntPtr pOutputSite);
        [PreserveSig] int GetOutputFormat(IntPtr pTargetFmtId, IntPtr pTargetWaveFormatEx, out Guid pOutputFormatId, out IntPtr ppCoMemOutputWaveFormatEx);
    }

    [ComVisible(true), Guid("D6C18D54-4DF5-4B50-B4BD-5BF06FEB1F5A"), ClassInterface(ClassInterfaceType.None)]
    public class Engine : ISpTTSEngine, ISpObjectWithToken
    {
        static readonly Guid WaveFormatEx = new Guid("C31ADBAE-527F-4ff5-A230-F62BB61FF70C");
        static int counter;
        IntPtr token = IntPtr.Zero;

        // Requests: "DSHB:<id>:<part>/<parts>:<base64>" (the game may add "Start" bookmarks).
        static readonly Regex Request = new Regex(
            @"^\s*(?:Start)?\s*DSHB:[A-Za-z0-9_-]{1,64}:\d{1,4}/\d{1,4}:[A-Za-z0-9+/=\s]*$",
            RegexOptions.CultureInvariant);
        // The addon's voice test (/dsh test): "DSHB-VOICE-TEST ...".
        static readonly Regex VoiceTest = new Regex(
            @"^\s*(?:Start)?\s*DSHB-VOICE-TEST [A-Za-z0-9 ]*$",
            RegexOptions.CultureInvariant);
        const int MaxText = 200000;

        static bool IsOurs(string text)
        {
            return text.Length <= MaxText && (Request.IsMatch(text) || VoiceTest.IsMatch(text));
        }

        static string DataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSHBridge");
        }

        static bool IsLink(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch { return true; }
        }

        static string SafeDir(string dir)
        {
            string data = DataDir();
            if (IsLink(data)) return null;
            if (dir != data && IsLink(dir)) return null;
            Directory.CreateDirectory(dir);
            if (IsLink(data) || IsLink(dir)) return null;
            return dir;
        }

        // %APPDATA%\DSHBridge\tts-engine.log (small, rotated). Never the spoken text.
        static void Log(string msg)
        {
            try
            {
                string dir = SafeDir(DataDir());
                if (dir == null) return;
                string file = Path.Combine(dir, "tts-engine.log");
                if (IsLink(file)) return;
                if (File.Exists(file) && new FileInfo(file).Length > 200000) File.Delete(file);
                string proc = "?";
                try { proc = System.Diagnostics.Process.GetCurrentProcess().ProcessName; } catch { }
                File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + proc + "] " + msg + Environment.NewLine);
            }
            catch { }
        }

        public Engine()
        {
            Log("engine loaded (" + (IntPtr.Size * 8) + "-bit)");
        }

        public int SetObjectToken(IntPtr pToken)
        {
            if (pToken != IntPtr.Zero) Marshal.AddRef(pToken);
            if (token != IntPtr.Zero) Marshal.Release(token);
            token = pToken;
            return 0;
        }

        public int GetObjectToken(out IntPtr ppToken)
        {
            ppToken = token;
            if (token != IntPtr.Zero) Marshal.AddRef(token);
            return 0;
        }

        // 16 kHz, 16-bit, mono PCM (no audio is ever written).
        public int GetOutputFormat(IntPtr pTargetFmtId, IntPtr pTargetWaveFormatEx, out Guid pOutputFormatId, out IntPtr ppCoMemOutputWaveFormatEx)
        {
            pOutputFormatId = WaveFormatEx;
            IntPtr wfx = Marshal.AllocCoTaskMem(18);
            Marshal.WriteInt16(wfx, 0, 1);
            Marshal.WriteInt16(wfx, 2, 1);
            Marshal.WriteInt32(wfx, 4, 16000);
            Marshal.WriteInt32(wfx, 8, 32000);
            Marshal.WriteInt16(wfx, 12, 2);
            Marshal.WriteInt16(wfx, 14, 16);
            Marshal.WriteInt16(wfx, 16, 0);
            ppCoMemOutputWaveFormatEx = wfx;
            return 0;
        }

        // SPVTEXTFRAG { SPVTEXTFRAG* pNext; SPVSTATE State; LPCWSTR pTextStart; ULONG ulTextLen; ... }
        static int TextOffset { get { return IntPtr.Size == 8 ? 80 : 56; } }
        static int ActionOffset { get { return IntPtr.Size; } }
        const int SPVA_Speak = 0, SPVA_SpellOut = 4;

        public int Speak(uint dwSpeakFlags, ref Guid rguidFormatId, IntPtr pWaveFormatEx, IntPtr pTextFragList, IntPtr pOutputSite)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                IntPtr frag = pTextFragList;
                int guard = 0;
                while (frag != IntPtr.Zero && guard++ < 100000)
                {
                    int action = Marshal.ReadInt32(frag, ActionOffset);
                    IntPtr text = Marshal.ReadIntPtr(frag, TextOffset);
                    int len = Marshal.ReadInt32(frag, TextOffset + IntPtr.Size);
                    if ((action == SPVA_Speak || action == SPVA_SpellOut) && text != IntPtr.Zero && len > 0)
                        sb.Append(Marshal.PtrToStringUni(text, len));
                    frag = Marshal.ReadIntPtr(frag, 0);
                }
                string all = sb.ToString();
                if (!IsOurs(all)) return 0;
                Log("message received: " + all.Length + " chars");
                Deliver(all);
            }
            catch (Exception e)
            {
                Log("Speak error: " + e.Message);
            }
            return 0;
        }

        const string PipeName = "DSHBridge";
        const int PipeConnectMs = 100;

        // One connection per message: UTF-8 text, then the client closes.
        static bool SendPipe(string text)
        {
            try
            {
                using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    pipe.Connect(PipeConnectMs);
                    byte[] bytes = new UTF8Encoding(false).GetBytes(text);
                    pipe.Write(bytes, 0, bytes.Length);
                    pipe.Flush();
                    pipe.WaitForPipeDrain();
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        static void Deliver(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            if (SendPipe(text))
            {
                Log("delivered by pipe");
                return;
            }
            string dir = SafeDir(Path.Combine(DataDir(), "tts-inbox"));
            if (dir == null)
            {
                Log("inbox folder refused (it is a link)");
                return;
            }
            string name = DateTime.UtcNow.Ticks.ToString("D20") + "-" + Interlocked.Increment(ref counter).ToString("D6");
            string tmp = Path.Combine(dir, name + ".tmp");
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            File.Move(tmp, Path.Combine(dir, name + ".txt"));
        }
    }
}
