// Real WASAPI render fixture for native-windows-isolation.py; no media/runtime deps.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
namespace {
template<class T> struct Com { T* p = nullptr; ~Com() { if(p) p->Release(); } T** put() { return &p; } T* operator->() { return p; } };
struct Handle { HANDLE p = nullptr; explicit Handle(HANDLE value) : p(value) {} ~Handle() { if(p && p != INVALID_HANDLE_VALUE) CloseHandle(p); } };
void check(HRESULT hr) { if(FAILED(hr)) throw std::runtime_error("WASAPI tone render failed: " + std::to_string(static_cast<unsigned long>(hr))); }
LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
  if(message == WM_CLOSE) { DestroyWindow(hwnd); return 0; }
  if(message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(hwnd, message, w, l);
}
}
int main(int argc, char** argv) {
  try {
    if(argc != 2 && argc != 4) throw std::runtime_error("Usage: tone.exe <frequency> [--child <frequency>]");
    double hz = std::stod(argv[1]);
    check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    struct Cleanup { ~Cleanup() { CoUninitialize(); } } cleanup;
    WNDCLASSW cls{}; cls.lpfnWndProc = procedure; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = L"CHDSSTestTone";
    if(!RegisterClassW(&cls)) throw std::runtime_error("Tone window class failed");
    std::wstring title = L"CHDSS test tone " + std::to_wstring(hz);
    HWND window = CreateWindowExW(0, cls.lpszClassName, title.c_str(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 400, 120, nullptr, nullptr, cls.hInstance, nullptr);
    if(!window) throw std::runtime_error("Tone window failed");
    ShowWindow(window, SW_SHOW);
    Com<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator.put())));
    Com<IMMDevice> device; check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.put()));
    Com<IAudioClient> client; check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.put())));
    WAVEFORMATEX format{}; format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32; format.nBlockAlign = 8; format.nAvgBytesPerSec = 384000;
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 1000000, 0, &format, nullptr));
    Com<IAudioRenderClient> render; check(client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(render.put())));
    UINT32 buffer = 0; check(client->GetBufferSize(&buffer));
    UINT64 sample = 0;
    auto fill = [&](UINT32 count) {
      BYTE* bytes = nullptr; check(render->GetBuffer(count, &bytes));
      auto data = reinterpret_cast<float*>(bytes);
      for(UINT32 i = 0; i < count; ++i, ++sample) {
        float value = static_cast<float>(0.12 * std::sin(6.283185307179586 * hz * static_cast<double>(sample) / 48000));
        data[i * 2] = value; data[i * 2 + 1] = value;
      }
      check(render->ReleaseBuffer(count, 0));
    };
    fill(buffer); check(client->Start());
    Handle job(CreateJobObjectW(nullptr, nullptr));
    Handle child(nullptr);
    if(argc == 4) {
      if(std::string(argv[2]) != "--child") throw std::runtime_error("Unknown fixture option");
      if(!job.p) throw std::runtime_error("Cannot create fixture child job");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if(!SetInformationJobObject(job.p, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw std::runtime_error("Cannot configure child job");
      wchar_t path[32768]; auto size = GetModuleFileNameW(nullptr, path, 32768);
      std::wstring frequency; for(char c : std::string(argv[3])) frequency += static_cast<wchar_t>(c);
      std::wstring command = L"\"" + std::wstring(path, size) + L"\" " + frequency;
      SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
      Handle sink(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
      STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = sink.p; startup.hStdOutput = sink.p; startup.hStdError = sink.p;
      PROCESS_INFORMATION info{};
      if(!CreateProcessW(path, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &info)) throw std::runtime_error("Cannot spawn tone child");
      child.p = info.hProcess; Handle thread(info.hThread);
      if(!AssignProcessToJobObject(job.p, child.p)) { TerminateProcess(child.p, 1); throw std::runtime_error("Cannot contain fixture child"); }
      ResumeThread(thread.p);
      // Let child render/create HWND before the harness takes --list.
      Sleep(500);
    }
    std::cout << "{\"windowId\":" << reinterpret_cast<std::uintptr_t>(window) << ",\"pid\":" << GetCurrentProcessId() << "}\n" << std::flush;
    bool running = true;
    while(running) {
      MSG message{};
      while(PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if(message.message == WM_QUIT) running = false;
        TranslateMessage(&message); DispatchMessageW(&message);
      }
      UINT32 padding = 0; check(client->GetCurrentPadding(&padding));
      if(buffer > padding) fill(buffer - padding);
      Sleep(5);
    }
    client->Stop(); return 0;
  } catch(const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
