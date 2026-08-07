# audio-bridge.ps1 - Windows Core Audio bridge for the Volume Monitor
# Stream Deck plugin.
#
# Two modes:
#   * Bridge mode (default): spawned by the plugin as
#         powershell -NoProfile -ExecutionPolicy Bypass -File audio-bridge.ps1
#     It compiles a small C# Core Audio client (Add-Type, C# 5 for PS 5.1)
#     and then speaks a line-delimited JSON protocol on stdin/stdout:
#
#         -> {"cmd":"state"}
#         <- {"ok":true,"device":"Speakers","deviceId":"{0.0...}","muted":false,"volume":64}
#         -> {"cmd":"setvol","volume":50}
#         -> {"cmd":"mute","muted":true}
#         -> {"cmd":"sessvol","id":"S-1-5-...","volume":40}
#         -> {"cmd":"sessmute","id":"S-1-5-...","muted":true}
#         -> {"cmd":"setdefault","id":"{0.0...}"}
#         -> {"cmd":"devices"}   -> {"ok":true,"devices":[{"id":..,"name":..},..]}
#         -> {"cmd":"sessions"}  -> {"ok":true,"sessions":[{"id":..,"app":..,"display":..,"pid":..,"volume":..,"muted":..},..]}
#         -> {"cmd":"ping"}      -> {"ok":true,"pong":true}
#         -> {"cmd":"quit"}
#
#   * Toast mode (one-shot, detached): used for desktop notifications
#         powershell -NoProfile -ExecutionPolicy Bypass -File audio-bridge.ps1 -Command toast -Title "Audio Output Switched" -Body "Changed to: Headphones"
#
# The C# code deliberately uses C# 5 syntax only (the PS 5.1 Add-Type
# compiler) and the classic IPolicyConfig.SetDefaultEndpoint call for
# per-user device switching (no admin rights needed).

param(
    [string]$Command = "",
    [string]$Title  = "",
    [string]$Body   = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string]$s) {
    [Console]::Out.WriteLine($s)
    [Console]::Out.Flush()
}

function Write-Json($obj) {
    Write-Line ($obj | ConvertTo-Json -Compress -Depth 8)
}

# ---------------------------------------------------------------------------
# C# Core Audio client (C# 5 compatible, Windows 10+)
# ---------------------------------------------------------------------------

$coreAudioSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace VolumeMonitorBridge
{
    public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
    public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int pcDevices);
        [PreserveSig] int Item(int nDevice, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out int pdwState);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int cProps);
        [PreserveSig] int GetAt(int iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(out int pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, IntPtr pguidEventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(int nChannel, float fLevelDB, IntPtr pguidEventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(int nChannel, float fLevel, IntPtr pguidEventContext);
        [PreserveSig] int GetChannelVolumeLevel(int nChannel, out float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(int nChannel, out float pfLevel);
        [PreserveSig] int SetMute(int bMute, IntPtr pguidEventContext);
        [PreserveSig] int GetMute(out int pbMute);
        [PreserveSig] int GetVolumeStepInfo(out int pnStep, out int pnStepCount);
        [PreserveSig] int VolumeStepUp(IntPtr pguidEventContext);
        [PreserveSig] int VolumeStepDown(IntPtr pguidEventContext);
        [PreserveSig] int QueryHardwareSupport(out int pdwHardwareSupportMask);
        [PreserveSig] int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(ref Guid AudioSessionGuid, int StreamFlags, out IAudioSessionControl ppSessionControl);
        [PreserveSig] int GetSimpleAudioVolume(ref Guid AudioSessionGuid, int StreamFlags, out ISimpleAudioVolume ppAudioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        [PreserveSig] int RegisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int RegisterDuckNotification(IntPtr sessionID, IntPtr audioDuckNotification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr sessionID, IntPtr audioDuckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int SessionCount);
        [PreserveSig] int GetSession(int SessionCount, out IAudioSessionControl Session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl
    {
        [PreserveSig] int GetState(out AudioSessionState pRetVal);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string NewDisplayName, IntPtr EventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string NewIconPath, IntPtr EventContext);
        [PreserveSig] int GetGroupingParam(out Guid pRetVal);
        [PreserveSig] int SetGroupingParam(ref Guid Override, IntPtr EventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float fLevel, IntPtr EventContext);
        [PreserveSig] int GetMasterVolume(out float pfLevel);
        [PreserveSig] int SetMute(int bMute, IntPtr EventContext);
        [PreserveSig] int GetMute(out int pbMute);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float pfPeak);
        [PreserveSig] int GetMeteringChannelCount(out int pnChannelCount);
        [PreserveSig] int GetChannelsPeakValues(int u32ChannelCount, [Out] float[] afPeakValues);
        [PreserveSig] int QueryHardwareSupport(out int pdwHardwareSupportMask);
    }

    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out IntPtr ppFormat);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, out IntPtr ppFormat);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pEndpointFormat, IntPtr pMixFormat);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, out long pmftDefaultPeriod, out long pmftMinimumPeriod);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, long pmftPeriod);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out int pMode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bFxStore, ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bFxStore, ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bVisible);
    }

    public static class CoreAudio
    {
        private const int CLSCTX_ALL = 0x17;
        private const int DEVICE_STATE_ACTIVE = 0x1;
        private static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        private static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        private static readonly Guid PKEY_Device_FriendlyName = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        private static IMMDeviceEnumerator _enumerator;

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);

        public static void EnsureCom()
        {
            // COINIT_APARTMENTTHREADED; S_OK (0) or S_FALSE (1) are both fine.
            try
            {
                CoInitializeEx(IntPtr.Zero, 2);
            }
            catch
            {
            }
        }

        private static IMMDeviceEnumerator Enumerator()
        {
            if (_enumerator == null)
            {
                _enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            }
            return _enumerator;
        }

        public static string DescribeHr(int hr)
        {
            if (hr == 0) return "OK";
            if (hr == unchecked((int)0x88890004)) return "no default audio device available";
            if (hr == unchecked((int)0x8889000A)) return "audio device not active";
            return "HRESULT 0x" + hr.ToString("X8");
        }

        public static string GetDeviceId(IMMDevice device)
        {
            try
            {
                string id;
                if (device.GetId(out id) == 0) return id;
            }
            catch
            {
            }
            return null;
        }

        public static string GetFriendlyName(IMMDevice device)
        {
            IPropertyStore store = null;
            try
            {
                int hr = device.OpenPropertyStore(0, out store);
                if (hr != 0 || store == null) return null;
                PROPERTYKEY key = new PROPERTYKEY();
                key.fmtid = PKEY_Device_FriendlyName;
                key.pid = 14;
                PROPVARIANT pv;
                hr = store.GetValue(ref key, out pv);
                if (hr != 0) return null;
                if (pv.vt == 31) // VT_LPWSTR
                {
                    string s = Marshal.PtrToStringUni(pv.pointerValue);
                    Marshal.FreeCoTaskMem(pv.pointerValue);
                    if (!string.IsNullOrEmpty(s)) return s;
                }
                return null;
            }
            catch
            {
                return null;
            }
            finally
            {
                if (store != null) Marshal.ReleaseComObject(store);
            }
        }

        public static int GetDefaultDeviceState(out string name, out string id, out int muted, out int volume)
        {
            name = null;
            id = null;
            muted = 0;
            volume = 0;
            IMMDevice device = null;
            try
            {
                int hr = Enumerator().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
                if (hr != 0 || device == null) return hr;
                id = GetDeviceId(device);
                name = GetFriendlyName(device);
                IntPtr volPtr;
                Guid iid = IID_IAudioEndpointVolume;
                hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volPtr);
                if (hr != 0 || volPtr == IntPtr.Zero) return hr;
                IAudioEndpointVolume vol = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(volPtr);
                float level;
                vol.GetMasterVolumeLevelScalar(out level);
                int m;
                vol.GetMute(out m);
                muted = m;
                level = level < 0f ? 0f : (level > 1f ? 1f : level);
                volume = (int)Math.Round(level * 100.0);
                return 0;
            }
            catch
            {
                return -1;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
            }
        }

        public static int SetMasterVolume(int percent)
        {
            IMMDevice device = null;
            try
            {
                int hr = Enumerator().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
                if (hr != 0 || device == null) return hr;
                IntPtr volPtr;
                Guid iid = IID_IAudioEndpointVolume;
                hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volPtr);
                if (hr != 0 || volPtr == IntPtr.Zero) return hr;
                IAudioEndpointVolume vol = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(volPtr);
                float level = (float)Math.Max(0, Math.Min(100, percent)) / 100.0f;
                hr = vol.SetMasterVolumeLevelScalar(level, IntPtr.Zero);
                return hr;
            }
            catch
            {
                return -1;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
            }
        }

        public static int SetMasterMute(int muted)
        {
            IMMDevice device = null;
            try
            {
                int hr = Enumerator().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
                if (hr != 0 || device == null) return hr;
                IntPtr volPtr;
                Guid iid = IID_IAudioEndpointVolume;
                hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volPtr);
                if (hr != 0 || volPtr == IntPtr.Zero) return hr;
                IAudioEndpointVolume vol = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(volPtr);
                hr = vol.SetMute(muted == 0 ? 0 : 1, IntPtr.Zero);
                return hr;
            }
            catch
            {
                return -1;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
            }
        }

        public static List<Dictionary<string, object>> GetDevices()
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            IMMDeviceCollection coll = null;
            try
            {
                int hr = Enumerator().EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out coll);
                if (hr != 0 || coll == null) return result;
                int count;
                coll.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IMMDevice dev = null;
                    try
                    {
                        hr = coll.Item(i, out dev);
                        if (hr != 0 || dev == null) continue;
                        Dictionary<string, object> entry = new Dictionary<string, object>();
                        entry["id"] = GetDeviceId(dev);
                        entry["name"] = GetFriendlyName(dev);
                        result.Add(entry);
                    }
                    catch
                    {
                    }
                    finally
                    {
                        if (dev != null) Marshal.ReleaseComObject(dev);
                    }
                }
            }
            catch
            {
            }
            finally
            {
                if (coll != null) Marshal.ReleaseComObject(coll);
            }
            return result;
        }

        private static IMMDevice GetDefaultDevice()
        {
            IMMDevice device;
            int hr = Enumerator().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
            if (hr != 0) return null;
            return device;
        }

        private static IAudioSessionManager2 GetSessionManager(IMMDevice device)
        {
            IntPtr mgrPtr;
            Guid iid = IID_IAudioSessionManager2;
            int hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out mgrPtr);
            if (hr != 0 || mgrPtr == IntPtr.Zero) return null;
            return (IAudioSessionManager2)Marshal.GetObjectForIUnknown(mgrPtr);
        }

        /// Derive an app name from the session icon path (the exe path for
        /// real applications). Resource-string icons ("@...") yield empty.
        private static string StripExePath(string iconPath)
        {
            if (string.IsNullOrEmpty(iconPath)) return "";
            string p = iconPath.Trim();
            int comma = p.IndexOf(',');
            if (comma > 0) p = p.Substring(0, comma);
            if (p.StartsWith("@")) return "";
            try
            {
                string name = System.IO.Path.GetFileName(p);
                if (name.ToLower().EndsWith(".exe")) name = name.Substring(0, name.Length - 4);
                return name;
            }
            catch
            {
                return "";
            }
        }

        /// Stable session identifier built from base-interface data. The
        /// IAudioSessionControl2 instance identifier is unavailable on the
        /// cross-process session controls, so we key by app + grouping GUID.
        private static string BuildSessionId(IAudioSessionControl ctl)
        {
            string display = "";
            try
            {
                string d;
                if (ctl.GetDisplayName(out d) == 0 && d != null && !d.StartsWith("@")) display = d;
            }
            catch
            {
            }
            string icon = "";
            try
            {
                string ic;
                if (ctl.GetIconPath(out ic) == 0 && ic != null) icon = ic;
            }
            catch
            {
            }
            Guid grouping = Guid.Empty;
            try
            {
                ctl.GetGroupingParam(out grouping);
            }
            catch
            {
            }
            string app = StripExePath(icon);
            string baseName = app.Length > 0 ? app : "app";
            return baseName + "|" + grouping.ToString();
        }

        private static void FillSession(IAudioSessionControl ctl, List<Dictionary<string, object>> result, int index)
        {
            try
            {
                AudioSessionState state;
                ctl.GetState(out state);
                if (state == AudioSessionState.Expired) return;

                string display = "";
                try
                {
                    string d;
                    if (ctl.GetDisplayName(out d) == 0 && d != null && !d.StartsWith("@")) display = d;
                }
                catch
                {
                }

                string icon = "";
                try
                {
                    string ic;
                    if (ctl.GetIconPath(out ic) == 0 && ic != null) icon = ic;
                }
                catch
                {
                }

                string app = StripExePath(icon);

                // Some real apps (e.g. VST hosts, players) never set a session
                // icon or display name. System sessions (audiodg, the
                // Background session, System Sounds) sit at 100% volume and
                // are silent. Treat an unnamed session as a real app when its
                // volume is not pinned to 100 or it is producing sound.
                bool isRealApp = false;
                float peak = 0f;
                if (app.Length == 0 && display.Length == 0)
                {
                    ISimpleAudioVolume v0 = ctl as ISimpleAudioVolume;
                    if (v0 != null)
                    {
                        float lv;
                        v0.GetMasterVolume(out lv);
                        if (lv < 0.999f) isRealApp = true;
                    }
                    if (!isRealApp)
                    {
                        IAudioMeterInformation meter = ctl as IAudioMeterInformation;
                        if (meter != null)
                        {
                            try
                            {
                                meter.GetPeakValue(out peak);
                                if (peak > 0.001f) isRealApp = true;
                            }
                            catch
                            {
                            }
                        }
                    }
                    if (isRealApp) display = "App";
                }

                if (app.Length == 0 && display.Length == 0) return;

                ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
                if (vol == null) return;

                float level = 0f;
                vol.GetMasterVolume(out level);
                int muted = 0;
                vol.GetMute(out muted);

                string id = BuildSessionId(ctl);
                if (id == null) return;

                Dictionary<string, object> entry = new Dictionary<string, object>();
                entry["id"] = id;
                entry["app"] = app;
                entry["display"] = display;
                entry["pid"] = 0;
                entry["volume"] = (int)Math.Round(level * 100.0);
                entry["muted"] = muted != 0;
                result.Add(entry);
            }
            catch
            {
            }
        }

        public static List<Dictionary<string, object>> GetSessions()
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            IMMDevice device = null;
            try
            {
                device = GetDefaultDevice();
                if (device == null) return result;
                IAudioSessionManager2 mgr = GetSessionManager(device);
                if (mgr == null) return result;
                IAudioSessionEnumerator enm;
                int hr = mgr.GetSessionEnumerator(out enm);
                if (hr != 0 || enm == null) return result;
                int count;
                enm.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl ctl;
                    hr = enm.GetSession(i, out ctl);
                    if (hr != 0 || ctl == null) continue;
                    try
                    {
                        FillSession(ctl, result, i);
                    }
                    catch
                    {
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(ctl);
                    }
                }
                Marshal.ReleaseComObject(enm);
                Marshal.ReleaseComObject(mgr);
            }
            catch
            {
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
            }
            return result;
        }

        private static bool FindSession(string sessionId, out IAudioSessionControl ctlOut, out ISimpleAudioVolume volOut)
        {
            ctlOut = null;
            volOut = null;
            IMMDevice device = null;
            IAudioSessionEnumerator enm = null;
            IAudioSessionManager2 mgr = null;
            try
            {
                device = GetDefaultDevice();
                if (device == null) return false;
                mgr = GetSessionManager(device);
                if (mgr == null) return false;
                int hr = mgr.GetSessionEnumerator(out enm);
                if (hr != 0 || enm == null) return false;
                int count;
                enm.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl ctl;
                    hr = enm.GetSession(i, out ctl);
                    if (hr != 0 || ctl == null) continue;
                    try
                    {
                        string id = BuildSessionId(ctl);
                        if (id != null && id == sessionId)
                        {
                            ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
                            if (vol != null)
                            {
                                ctlOut = ctl;
                                volOut = vol;
                                return true;
                            }
                        }
                    }
                    catch
                    {
                    }
                    Marshal.ReleaseComObject(ctl);
                }
            }
            catch
            {
            }
            finally
            {
                if (enm != null) Marshal.ReleaseComObject(enm);
                if (mgr != null) Marshal.ReleaseComObject(mgr);
                if (device != null) Marshal.ReleaseComObject(device);
            }
            return false;
        }

        public static int FindSessionVolume(string sessionId, out int volume, out int muted)
        {
            volume = 0;
            muted = 0;
            IAudioSessionControl ctl;
            ISimpleAudioVolume vol;
            if (!FindSession(sessionId, out ctl, out vol)) return unchecked((int)0x80004005);
            try
            {
                float level;
                vol.GetMasterVolume(out level);
                int m;
                vol.GetMute(out m);
                level = level < 0f ? 0f : (level > 1f ? 1f : level);
                volume = (int)Math.Round(level * 100.0);
                muted = m;
                return 0;
            }
            finally
            {
                Marshal.ReleaseComObject(ctl);
            }
        }

        public static int SetSessionVolume(string sessionId, int percent)
        {
            IAudioSessionControl ctl;
            ISimpleAudioVolume vol;
            if (!FindSession(sessionId, out ctl, out vol)) return unchecked((int)0x80004005);
            try
            {
                float level = (float)Math.Max(0, Math.Min(100, percent)) / 100.0f;
                return vol.SetMasterVolume(level, IntPtr.Zero);
            }
            finally
            {
                Marshal.ReleaseComObject(ctl);
            }
        }

        public static int SetSessionMute(string sessionId, int muted)
        {
            IAudioSessionControl ctl;
            ISimpleAudioVolume vol;
            if (!FindSession(sessionId, out ctl, out vol)) return unchecked((int)0x80004005);
            try
            {
                return vol.SetMute(muted == 0 ? 0 : 1, IntPtr.Zero);
            }
            finally
            {
                Marshal.ReleaseComObject(ctl);
            }
        }

        public static int SetDefaultDevice(string deviceId)
        {
            try
            {
                Type type = Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9"));
                if (type == null) return -1;
                object o = Activator.CreateInstance(type);
                IPolicyConfig pc = (IPolicyConfig)o;
                return pc.SetDefaultEndpoint(deviceId, 0);
            }
            catch
            {
                return -1;
            }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $coreAudioSource -Language CSharp
} catch {
    Write-Json @{ ok = $false; event = 'error'; error = ("Add-Type failed: " + $_.Exception.Message) }
    exit 1
}

# ---------------------------------------------------------------------------
# Toast notifications (WinRT first, NotifyIcon fallback)
# ---------------------------------------------------------------------------

function Show-NotificationToast([string]$ToastTitle, [string]$ToastBody) {
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $textNodes = $template.GetElementsByTagName('text')
        [void]$textNodes.Item(0).AppendChild($template.CreateTextNode($ToastTitle))
        [void]$textNodes.Item(1).AppendChild($template.CreateTextNode($ToastBody))
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier().Show($toast)
        return
    } catch {
        # fall through to NotifyIcon
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $notify = New-Object System.Windows.Forms.NotifyIcon
        $notify.Icon = [System.Drawing.SystemIcons]::Information
        $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $notify.BalloonTipTitle = $ToastTitle
        $notify.BalloonTipText = $ToastBody
        $notify.Visible = $true
        $notify.ShowBalloonTip(4000)
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.Application]::DoEvents()
        $notify.Dispose()
    } catch {
        # best effort only
    }
}

# ---------------------------------------------------------------------------
# Command handling (bridge mode)
# ---------------------------------------------------------------------------

function Handle-Request([string]$Line) {
    try {
        $req = $Line | ConvertFrom-Json
    } catch {
        return
    }
    $cmd = [string]$req.cmd
    switch ($cmd) {
        'ping' {
            Write-Json @{ ok = $true; pong = $true }
        }
        'state' {
            $name = $null; $id = $null; $muted = 0; $volume = 0
            $hr = [VolumeMonitorBridge.CoreAudio]::GetDefaultDeviceState([ref]$name, [ref]$id, [ref]$muted, [ref]$volume)
            if ($hr -eq 0) {
                Write-Json @{ ok = $true; device = $name; deviceId = $id; muted = ($muted -ne 0); volume = $volume }
            } else {
                Write-Json @{ ok = $false; error = ('state: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) }
            }
        }
        'setvol' {
            $volume = [int]$req.volume
            $hr = [VolumeMonitorBridge.CoreAudio]::SetMasterVolume($volume)
            if ($hr -eq 0) { Write-Json @{ ok = $true; volume = $volume } }
            else { Write-Json @{ ok = $false; error = ('setvol: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'mute' {
            $muted = 0
            if ($req.muted) { $muted = 1 }
            $hr = [VolumeMonitorBridge.CoreAudio]::SetMasterMute($muted)
            if ($hr -eq 0) { Write-Json @{ ok = $true; muted = ($muted -ne 0) } }
            else { Write-Json @{ ok = $false; error = ('mute: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'devices' {
            $devices = [VolumeMonitorBridge.CoreAudio]::GetDevices()
            Write-Json @{ ok = $true; devices = $devices }
        }
        'sessions' {
            $sessions = [VolumeMonitorBridge.CoreAudio]::GetSessions()
            Write-Json @{ ok = $true; sessions = $sessions }
        }
        'sessvol' {
            $id = [string]$req.id
            $volume = [int]$req.volume
            $hr = [VolumeMonitorBridge.CoreAudio]::SetSessionVolume($id, $volume)
            if ($hr -eq 0) { Write-Json @{ ok = $true } }
            else { Write-Json @{ ok = $false; error = ('sessvol: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'sessstate' {
            $id = [string]$req.id
            $volume = 0; $muted = 0
            $hr = [VolumeMonitorBridge.CoreAudio]::FindSessionVolume($id, [ref]$volume, [ref]$muted)
            if ($hr -eq 0) { Write-Json @{ ok = $true; volume = $volume; muted = ($muted -ne 0) } }
            else { Write-Json @{ ok = $false; error = ('sessstate: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'sessmute' {
            $id = [string]$req.id
            $muted = 0
            if ($req.muted) { $muted = 1 }
            $hr = [VolumeMonitorBridge.CoreAudio]::SetSessionMute($id, $muted)
            if ($hr -eq 0) { Write-Json @{ ok = $true } }
            else { Write-Json @{ ok = $false; error = ('sessmute: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'setdefault' {
            $id = [string]$req.id
            $hr = [VolumeMonitorBridge.CoreAudio]::SetDefaultDevice($id)
            if ($hr -eq 0) { Write-Json @{ ok = $true } }
            else { Write-Json @{ ok = $false; error = ('setdefault: ' + [VolumeMonitorBridge.CoreAudio]::DescribeHr($hr)) } }
        }
        'quit' {
            exit 0
        }
        default {
            Write-Json @{ ok = $false; error = ('unknown command: ' + $cmd) }
        }
    }
}

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

if ($Command -eq 'toast') {
    Show-NotificationToast $Title $Body
    exit 0
}

[VolumeMonitorBridge.CoreAudio]::EnsureCom()
Write-Json @{ event = 'ready' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    Handle-Request $line
}

exit 0
