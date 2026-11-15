// Catwhale pet - WASAPI audio session probe (compiled by Add-Type at runtime)
// Reports, per audio session: process id, process name, state, peak level.
// This is the layer that catches apps which never register with SMTC (NetEase CloudMusic, etc).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PetAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
    internal enum AUDIO_SESSION_STATE { Inactive = 0, Active = 1, Expired = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object a);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        int NotImpl1();
        int NotImpl2();
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification(string sessionId, IntPtr duckNotification);
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl raw);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl
    {
        int GetState(out AUDIO_SESSION_STATE state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid groupingParam);
        int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        // IAudioSessionControl
        int GetState(out AUDIO_SESSION_STATE state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid groupingParam);
        int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        // IAudioSessionControl2
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out uint pid);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int channelCount);
        int GetChannelsPeakValues(int channelCount, [Out] float[] peakValues);
        int QueryHardwareSupport(out int hardwareSupportMask);
    }

    public class SessionInfo
    {
        public uint pid;
        public string proc = "";
        public string state = "";
        public float peak = 0f;
        public string device = "";
        public string displayName = "";
    }

    public static class Probe
    {
        static T Activate<T>(IMMDevice dev, Guid iid) where T : class
        {
            object o;
            int hr = dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
            if (hr != 0 || o == null) return null;
            return o as T;
        }

        public static List<SessionInfo> Sessions()
        {
            var result = new List<SessionInfo>();
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDeviceCollection coll;
            if (enumerator.EnumAudioEndpoints(EDataFlow.eRender, 1 /* DEVICE_STATE_ACTIVE */, out coll) != 0 || coll == null)
                return result;
            int nDev;
            coll.GetCount(out nDev);
            for (int d = 0; d < nDev; d++)
            {
                IMMDevice dev;
                if (coll.Item(d, out dev) != 0 || dev == null) continue;
                string devId = "";
                try { dev.GetId(out devId); } catch { }
                var mgr = Activate<IAudioSessionManager2>(dev, typeof(IAudioSessionManager2).GUID);
                if (mgr == null) continue;
                IAudioSessionEnumerator sessEnum;
                if (mgr.GetSessionEnumerator(out sessEnum) != 0 || sessEnum == null) continue;
                int nSess;
                sessEnum.GetCount(out nSess);
                for (int i = 0; i < nSess; i++)
                {
                    IAudioSessionControl raw;
                    if (sessEnum.GetSession(i, out raw) != 0 || raw == null) continue;
                    var c2 = raw as IAudioSessionControl2;
                    var info = new SessionInfo();
                    info.device = devId;
                    AUDIO_SESSION_STATE st;
                    try { raw.GetState(out st); info.state = st.ToString(); } catch { }
                    if (c2 != null)
                    {
                        uint pid;
                        if (c2.GetProcessId(out pid) == 0) info.pid = pid;
                        try
                        {
                            if (pid > 0)
                            {
                                var p = Process.GetProcessById((int)pid);
                                info.proc = p.ProcessName;
                            }
                        }
                        catch { }
                    }
                    if (info.pid == 0) info.proc = "System";
                    var meter = raw as IAudioMeterInformation;
                    if (meter != null)
                    {
                        float peak;
                        if (meter.GetPeakValue(out peak) == 0) info.peak = peak;
                    }
                    result.Add(info);
                }
            }
            return result;
        }
    }
}
