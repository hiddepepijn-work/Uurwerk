# Which other apps use the microphone or play sound right now, from Windows' own audio
# sessions (Core Audio). One JSON line every interval: process ids, nothing else.
#   render:  [{ "pid": 1234, "name": "Spotify", "peak": 0.31 }]   active sessions on the speakers
#   capture: [{ "pid": 5678, "name": "Teams", "peak": 0 }]        active sessions on the microphone
param([int]$IntervalMs = 1500)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace UurwerkAudio {
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr groupingParam, int flags, out IntPtr control);
    int GetSimpleAudioVolume(IntPtr groupingParam, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(IntPtr name, IntPtr context);
    int GetIconPath(out IntPtr path);
    int SetIconPath(IntPtr path, IntPtr context);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(IntPtr param, IntPtr context);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}

  public static class Probe {
    // One line of JSON: the sounding sessions on the speakers, the active ones on the microphone.
    public static string Sample() {
      IMMDeviceEnumerator devices = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      return "{\"render\":[" + Sessions(devices, 0, true) + "],\"capture\":[" + Sessions(devices, 1, false) + "]}";
    }

    static string NameOf(uint pid) {
      try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Replace("\"", ""); } catch { return "?"; }
    }

    static string Sessions(IMMDeviceEnumerator devices, int flow, bool withPeak) {
      List<string> parts = new List<string>();
      // Communications and console defaults can differ (a headset for calls): look at both.
      List<uint> seen = new List<uint>();
      for (int role = 0; role <= 2; role += 2) {
        IMMDevice device;
        try { devices.GetDefaultAudioEndpoint(flow, role, out device); } catch { continue; }
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object manager;
        device.Activate(ref iid, 23, IntPtr.Zero, out manager);
        IAudioSessionEnumerator sessions;
        ((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions);
        int count;
        sessions.GetCount(out count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl2 session;
          sessions.GetSession(i, out session);
          if (session.IsSystemSoundsSession() == 0) continue;
          int state;
          session.GetState(out state);
          if (state != 1) continue;
          uint pid;
          session.GetProcessId(out pid);
          if (seen.Contains(pid)) continue;
          seen.Add(pid);
          float peak = 0;
          if (withPeak) ((IAudioMeterInformation)session).GetPeakValue(out peak);
          parts.Add("{\"pid\":" + pid + ",\"name\":\"" + NameOf(pid) + "\",\"peak\":" + peak.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) + "}");
        }
      }
      return String.Join(",", parts.ToArray());
    }
  }
}
'@

while ($true) {
  try { [Console]::Out.WriteLine([UurwerkAudio.Probe]::Sample()) } catch { [Console]::Out.WriteLine('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
