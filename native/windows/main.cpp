// Windows x64 process-scoped WASAPI loopback. Never opens a whole-endpoint loopback.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <objbase.h>
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// SDK ABI introduced in build 20348. llvm-mingw lacks this header, not the API.
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK };
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0 };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; };
struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }; };
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
static_assert(sizeof(AUDIOCLIENT_ACTIVATION_PARAMS) == 12, "Windows SDK activation ABI");
#endif
#include "policy.hpp"
#include <atomic>
#include <csignal>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

using namespace chdss;
namespace {
HANDLE stop_event = nullptr;
std::atomic<bool> shutdown_requested{false};
void request_stop() { shutdown_requested.store(true); SetEvent(stop_event); }
void check(HRESULT hr, const char* context) {
  if (FAILED(hr)) {
    char code[32]; std::snprintf(code, sizeof(code), " (HRESULT 0x%08lX)", static_cast<unsigned long>(hr));
    throw std::runtime_error(std::string(context) + code);
  }
}
std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}
std::string json_string(const std::string& text) {
  std::string out = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 32) { char b[7]; std::snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
    else out += static_cast<char>(c);
  }
  return out + "\"";
}
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
template<class T> struct Com {
  T* value = nullptr;
  ~Com() { if (value) value->Release(); }
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  T** put() { if (value) value->Release(); value = nullptr; return &value; }
  T* operator->() const { return value; }
};
struct ComRuntime {
  ComRuntime() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "Initialize COM MTA"); }
  ~ComRuntime() { CoUninitialize(); }
};
bool stopping() { return WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0; }
BOOL WINAPI console_stop(DWORD event) {
  if (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT || event == CTRL_CLOSE_EVENT || event == CTRL_SHUTDOWN_EVENT) {
    request_stop(); return TRUE;
  }
  return FALSE;
}
void signal_stop(int) { request_stop(); }
std::uint64_t created(HANDLE h) {
  FILETIME a{}, b{}, c{}, d{};
  if (!GetProcessTimes(h, &a, &b, &c, &d)) return 0;
  return (static_cast<std::uint64_t>(a.dwHighDateTime) << 32) | a.dwLowDateTime;
}
Processes snapshot() {
  Handle snap(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snap.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot enumerate process identities");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  Processes out;
  if (!Process32FirstW(snap.value, &entry)) throw std::runtime_error("Cannot read process snapshot");
  do {
    Process p{entry.th32ProcessID, entry.th32ParentProcessID, 0, ""};
    Handle handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, p.pid));
    if (handle.value) {
      wchar_t path[32768]; DWORD len = 32768;
      p.created = created(handle.value);
      if (QueryFullProcessImageNameW(handle.value, 0, path, &len)) p.image = utf8(std::wstring(path, len));
    }
    out.push_back(std::move(p));
  } while (Process32NextW(snap.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) throw std::runtime_error("Process snapshot incomplete");
  return out;
}

DWORD owner_root(const Processes& ps) {
  auto self = process(ps, GetCurrentProcessId());
  auto parent = self ? process(ps, self->parent) : nullptr;
  if (verified(parent) && parent_edge(self, parent)) {
    auto name = basename(parent->image);
    if (name == "electron.exe" || name == "chdss.exe") return application_root(ps, parent->pid);
  }
  return application_root(ps, GetCurrentProcessId());
}
std::vector<std::uint32_t> active_sessions() {
  Com<IMMDeviceEnumerator> enumerator;
  check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator.put())), "Enumerate audio endpoints");
  Com<IMMDeviceCollection> devices;
  check(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, devices.put()), "Enumerate active render endpoints");
  UINT count = 0; check(devices->GetCount(&count), "Count render endpoints");
  std::vector<std::uint32_t> pids;
  for (UINT i = 0; i < count; ++i) {
    Com<IMMDevice> device; check(devices->Item(i, device.put()), "Read render endpoint");
    Com<IAudioSessionManager2> manager;
    check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(manager.put())), "Enumerate endpoint sessions");
    Com<IAudioSessionEnumerator> sessions;
    check(manager->GetSessionEnumerator(sessions.put()), "Read audio sessions");
    int size = 0; check(sessions->GetCount(&size), "Count audio sessions");
    for (int j = 0; j < size; ++j) {
      Com<IAudioSessionControl> control;
      check(sessions->GetSession(j, control.put()), "Read audio session");
      AudioSessionState state;
      check(control->GetState(&state), "Read audio session state");
      if (state != AudioSessionStateActive) continue;
      Com<IAudioSessionControl2> session;
      check(control->QueryInterface(__uuidof(IAudioSessionControl2), reinterpret_cast<void**>(session.put())), "Resolve session process");
      DWORD pid = 0;
      auto result = session->GetProcessId(&pid);
      // Multi-process sessions are ambiguous. Fail closed: neither guess nor capture all.
      if (result == S_OK && pid && session->IsSystemSoundsSession() != S_OK) pids.push_back(pid);
    }
  }
  std::sort(pids.begin(), pids.end()); pids.erase(std::unique(pids.begin(), pids.end()), pids.end());
  return pids;
}
struct Listing { const Processes* processes; bool first = true; };
BOOL CALLBACK list_window(HWND hwnd, LPARAM parameter) {
  auto& listing = *reinterpret_cast<Listing*>(parameter);
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  int size = GetWindowTextLengthW(hwnd);
  if (!size) return TRUE;
  std::wstring title(size + 1, L'\0');
  title.resize(GetWindowTextW(hwnd, title.data(), size + 1));
  DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
  auto p = process(*listing.processes, pid);
  if (!verified(p)) return TRUE;
  DWORD root = 0;
  try { root = application_root(*listing.processes, pid); } catch (...) { return TRUE; }
  if (!listing.first) std::cout << ',';
  listing.first = false;
  auto id = reinterpret_cast<std::uintptr_t>(hwnd);
  std::cout << "{\"windowId\":" << id << ",\"pid\":" << pid << ",\"rootPid\":" << root
    << ",\"name\":" << json_string(utf8(title)) << ",\"executable\":" << json_string(p->image)
    << ",\"sourceId\":" << json_string("window:" + std::to_string(id) + ":0") << '}';
  return TRUE;
}
void list_windows() {
  auto ps = snapshot(); Listing listing{&ps};
  std::cout << '[';
  if (!EnumWindows(list_window, reinterpret_cast<LPARAM>(&listing))) throw std::runtime_error("Cannot enumerate windows");
  std::cout << "]\n";
}
void require_supported_windows() {
  using VersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto fn = reinterpret_cast<VersionFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
  if (!fn || fn(&version) != 0 || version.dwMajorVersion < 10 || version.dwBuildNumber < 20348)
    throw std::runtime_error("Process-loopback requires Windows build 20348 or newer; no whole-system fallback");
}
class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  std::atomic<ULONG> references_{1};
public:
  Handle done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  HRESULT result = E_PENDING;
  Com<IAudioClient> client;
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  PROPVARIANT property{};
  explicit Activation(DWORD pid) {
    if (!done.value) throw std::runtime_error("Cannot create activation event");
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    property.vt = VT_BLOB; property.blob.cbSize = sizeof(params);
    property.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler))
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (iid == __uuidof(IAgileObject)) *out = static_cast<IAgileObject*>(this);
    else return E_NOINTERFACE;
    AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    auto count = --references_; if (!count) delete this; return count;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    Com<IUnknown> unknown; HRESULT activation = E_FAIL;
    result = operation->GetActivateResult(&activation, unknown.put());
    if (SUCCEEDED(result)) result = activation;
    if (SUCCEEDED(result)) result = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(client.put()));
    SetEvent(done.value); return S_OK;
  }
};
class Capture {
  Com<IAudioClient> client_;
  Com<IAudioCaptureClient> capture_;
  Handle event_{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
  Handle process_;
public:
  Process identity;
  Timeline timeline;
  explicit Capture(const Process& p) : process_(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, p.pid)), identity(p) {
    if (!process_.value || created(process_.value) != p.created) throw std::runtime_error("Capture process identity changed");
    if (!event_.value) throw std::runtime_error("Cannot create audio event");
    Com<Activation> activation; *activation.put() = new Activation(p.pid);
    Com<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation->property, activation.value, operation.put()), "Activate process-loopback");
    HANDLE waits[] = {stop_event, activation->done.value};
    auto wait = WaitForMultipleObjects(2, waits, FALSE, 10000);
    if (wait == WAIT_OBJECT_0) throw std::runtime_error("Capture stopped during activation");
    if (wait != WAIT_OBJECT_0 + 1) throw std::runtime_error("Process-loopback activation timed out");
    check(activation->result, "Process-loopback activation failed");
    client_.value = activation->client.value; client_->AddRef();
    // Request the actual output format. AUTOCONVERTPCM makes Windows resample/remix.
    // Never label an endpoint's native PCM as float/48 kHz.
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32; format.nBlockAlign = 8; format.nAvgBytesPerSec = 48000 * 8;
    check(client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, 0, &format, nullptr), "Initialize float32/stereo/48k process loopback");
    check(client_->SetEventHandle(event_.value), "Set loopback event");
    check(client_->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(capture_.put())), "Get process capture client");
    if (WaitForSingleObject(process_.value, 0) != WAIT_TIMEOUT) throw std::runtime_error("Application exited during activation");
    check(client_->Start(), "Start process-loopback");
  }
  ~Capture() { if (client_.value) client_->Stop(); }
  bool alive() const { return WaitForSingleObject(process_.value, 0) == WAIT_TIMEOUT; }
  void drain(std::uint64_t origin) {
    UINT32 size = 0;
    for (;;) {
      check(capture_->GetNextPacketSize(&size), "Read loopback packet size");
      if (!size) break;
      BYTE* data = nullptr; DWORD flags = 0; UINT64 position = 0, qpc = 0;
      check(capture_->GetBuffer(&data, &size, &flags, &position, &qpc), "Read loopback packet");
      try {
        if (!(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) {
          auto start = static_cast<std::int64_t>(std::llround((static_cast<long double>(qpc) - origin) * 48000 / 10000000));
          Packet packet{start, std::vector<float>(size * 2, 0)};
          if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data)
            std::memcpy(packet.samples.data(), data, packet.samples.size() * sizeof(float));
          for (auto& sample : packet.samples) if (!std::isfinite(sample)) sample = 0;
          timeline.push(std::move(packet));
        }
      } catch (...) { capture_->ReleaseBuffer(size); throw; }
      check(capture_->ReleaseBuffer(size), "Release loopback packet");
    }
  }
};
DWORD WINAPI read_stdin(void*) {
  char buffer[256]; DWORD read = 0;
  while (!stopping()) {
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &read, nullptr) || !read) {
      if (!stopping()) request_stop();
      break;
    }
  }
  return 0;
}
class InputThread {
  Handle thread_{CreateThread(nullptr, 0, read_stdin, nullptr, 0, nullptr)};
public:
  InputThread() { if (!thread_.value) throw std::runtime_error("Cannot create stdin EOF worker"); }
  ~InputThread() {
    SetEvent(stop_event); CancelSynchronousIo(thread_.value);
    WaitForSingleObject(thread_.value, INFINITE);
  }
};
class Output {
  Handle ready_{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
  std::mutex mutex_;
  std::deque<std::vector<float>> queue_;
  Handle thread_;
  static DWORD WINAPI run(void* parameter) {
    auto& self = *static_cast<Output*>(parameter);
    HANDLE waits[] = {stop_event, self.ready_.value};
    while (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
      for (;;) {
        std::vector<float> block;
        { std::lock_guard<std::mutex> lock(self.mutex_); if (self.queue_.empty()) break;
          block = std::move(self.queue_.front()); self.queue_.pop_front(); }
        auto data = reinterpret_cast<const BYTE*>(block.data()); DWORD left = static_cast<DWORD>(block.size() * sizeof(float));
        while (left && !stopping()) {
          DWORD written = 0;
          if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data, left, &written, nullptr) || !written) {
            if (!stopping()) request_stop();
            return 0; // broken pipe / consumer closed = clean stop
          }
          left -= written; data += written;
        }
      }
    }
    return 0;
  }
public:
  Output() {
    if (!ready_.value) throw std::runtime_error("Cannot create PCM output event");
    thread_.value = CreateThread(nullptr, 0, run, this, 0, nullptr);
    if (!thread_.value) throw std::runtime_error("Cannot create PCM output worker");
  }
  ~Output() {
    SetEvent(stop_event);
    // Cancel blocked pipe writes too, otherwise EOF/signals could hang with an unread stdout.
    CancelSynchronousIo(thread_.value); SetEvent(ready_.value);
    WaitForSingleObject(thread_.value, INFINITE);
  }
  void push(std::vector<float> block) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (queue_.size() >= 64) throw std::runtime_error("PCM consumer too slow; stopping instead of unbounded buffering");
    queue_.push_back(std::move(block)); SetEvent(ready_.value);
  }
};
std::uint64_t qpc_100ns() {
  LARGE_INTEGER time{}, frequency{};
  QueryPerformanceCounter(&time); QueryPerformanceFrequency(&frequency);
  return static_cast<std::uint64_t>(static_cast<long double>(time.QuadPart) * 10000000 / frequency.QuadPart);
}
void run_capture(Source source) {
  auto current = snapshot(); ProcessHistory history;
  auto own = owner_root(current);
  auto ps = history.update(current, own);
  DWORD selected_pid = 0, selected_root = 0;
  std::uint64_t selected_created = 0;
  HWND window = reinterpret_cast<HWND>(source.window);
  if (source.scope == Scope::application) {
    if (!IsWindow(window) || !GetWindowThreadProcessId(window, &selected_pid)) throw std::runtime_error("Selected HWND is no longer valid");
    selected_root = application_root(ps, selected_pid);
    selected_created = process(ps, selected_pid)->created;
  }
  std::map<DWORD, std::unique_ptr<Capture>> streams;
  if (source.scope == Scope::application) streams.emplace(selected_root, std::make_unique<Capture>(*process(ps, selected_root)));
  else {
    // Even silent desktops prove API/format activation before announcing readiness.
    Capture probe(*process(ps, GetCurrentProcessId()));
  }
  Output output;
  std::cerr << "{\"type\":\"ready\",\"sampleRate\":48000,\"channels\":2,\"scope\":\""
    << (source.scope == Scope::application ? "application" : "display") << "\"}\n" << std::flush;
  auto origin = qpc_100ns(); std::int64_t frame = 0;
  std::uint64_t next_sessions = 0;
  std::vector<std::uint32_t> sessions;
  std::set<std::pair<DWORD, std::uint64_t>> tainted;
  constexpr std::uint64_t delay = 2000000; // 200 ms timestamp-aligned quarantine/lookahead
  while (!stopping()) {
    current = snapshot(); ps = history.update(current, own);
    auto now = qpc_100ns();
    std::vector<std::uint32_t> wanted;
    if (source.scope == Scope::display) {
      if (now >= next_sessions) { sessions = active_sessions(); next_sessions = now + 2500000; }
      wanted = display_roots(ps, sessions, GetCurrentProcessId());
      // display_roots uses helper identity; additional owner root covers dev Electron CHDSS.
      wanted.erase(std::remove_if(wanted.begin(), wanted.end(), [&](auto pid) { return !safe_tree(ps, pid, own); }), wanted.end());
      for (auto& stream : streams) if (!safe_tree(ps, stream.first, own)) tainted.insert({stream.first, stream.second->identity.created});
      wanted.erase(std::remove_if(wanted.begin(), wanted.end(), [&](auto pid) {
        auto p = process(current, pid);
        return !verified(p) || tainted.count({pid, p->created});
      }), wanted.end());
    } else {
      DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
      auto selected = process(current, selected_pid);
      if (pid != selected_pid || !verified(selected) || selected->created != selected_created)
        throw std::runtime_error("Selected window application exited or changed identity");
      wanted.push_back(selected_root);
    }
    // First remove and destroy queues for roots that became excluded, exited, or changed.
    // No already-buffered packet from a newly tainted tree is allowed into the mix.
    for (auto i = streams.begin(); i != streams.end();) {
      auto p = process(current, i->first);
      if (!verified(p) || p->created != i->second->identity.created || !i->second->alive() ||
          std::find(wanted.begin(), wanted.end(), i->first) == wanted.end()) i = streams.erase(i);
      else ++i;
    }
    for (auto pid : wanted) {
      if (streams.count(pid)) continue;
      auto p = process(current, pid);
      if (!verified(p)) {
        if (source.scope == Scope::application) throw std::runtime_error("Selected application root exited");
        continue;
      }
      streams.emplace(pid, std::make_unique<Capture>(*p));
    }
    for (auto& stream : streams) stream.second->drain(origin);
    now = qpc_100ns();
    if (now > origin + delay + static_cast<std::uint64_t>(frame) * 10000000 / 48000 + 5000000)
      throw std::runtime_error("Capture clock fell behind; stopping rather than emitting stale audio");
    // At most one quantum per snapshot: refresh exclusion before every output block.
    if (now >= origin + delay + static_cast<std::uint64_t>(frame + 480) * 10000000 / 48000) {
      std::vector<std::vector<float>> inputs;
      for (auto& stream : streams) inputs.push_back(stream.second->timeline.take(frame, 480));
      output.push(mix(inputs, 480)); frame += 480;
    }
    WaitForSingleObject(stop_event, 5);
  }
}
}
int main(int argc, char** argv) {
  Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr)); stop_event = stop.value;
  if (!stop_event) { std::cerr << "{\"type\":\"error\",\"message\":\"Cannot initialize stop event\"}\n"; return 1; }
  SetConsoleCtrlHandler(console_stop, TRUE);
  std::signal(SIGINT, signal_stop); std::signal(SIGTERM, signal_stop);
  try {
    require_supported_windows(); ComRuntime com;
    if (argc == 2 && std::string(argv[1]) == "--list") list_windows();
    else if (argc == 3 && std::string(argv[1]) == "--source") {
      auto source = parse_source(argv[2]);
      InputThread input;
      run_capture(source);
    }
    else throw std::runtime_error("Usage: chdss-audio.exe --list | --source window:<decimal HWND>:<id> | --source screen:<id>:<id>");
    SetEvent(stop_event); return 0;
  } catch (const std::exception& error) {
    // A requested shutdown during asynchronous activation is not a capture failure.
    bool requested = shutdown_requested.load(); SetEvent(stop_event);
    if (requested) return 0;
    std::cerr << "{\"type\":\"error\",\"message\":" << json_string(error.what()) << "}\n" << std::flush;
    return 1;
  }
}
