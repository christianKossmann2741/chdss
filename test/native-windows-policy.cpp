#include "../native/windows/policy.hpp"
#include <iostream>
#include <stdexcept>
using namespace chdss;
static_assert(OutputClock::default_delay <= 1000000, "lookahead is audible latency; keep it at or under 100 ms");
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
int main() { try {
  CHECK(process_loopback_candidate(10, 19041)); // updated Windows 10 version 2004
  CHECK(process_loopback_candidate(10, 19045)); // Windows 10 version 22H2
  CHECK(process_loopback_candidate(10, 22000)); // Windows 11
  CHECK(!process_loopback_candidate(10, 18363));
  CHECK(!process_loopback_candidate(6, 9600));
  auto w = parse_source("window:123:0");
  CHECK(w.scope == Scope::application && w.window == 123);
  CHECK(parse_source("screen:0:0").scope == Scope::display);
  for (auto s : {"window:0:0", "window:-1:0", "window:0x12:0", "window:123:0junk", "screen:x:0", "window:18446744073709551616:0"}) {
    bool failed = false; try { parse_source(s); } catch (const std::exception&) { failed = true; }
    CHECK(failed);
  }
  Processes p = {
    {1, 0, 1, "c:/windows/explorer.exe"},
    {10, 1, 2, "c:/chrome/chrome.exe"},
    {11, 10, 3, "c:/chrome/chrome.exe"},
    {12, 10, 4, "c:/chrome/chrome.exe"},
    {20, 1, 2, "c:/discord/discord.exe"},
    {21, 20, 3, "c:/discord/discord.exe"},
    {30, 1, 2, "c:/chdss/chdss.exe"},
    {31, 30, 3, "c:/chdss/chdss-audio.exe"},
    {40, 1, 2, "c:/music/music.exe"}
  };
  CHECK(application_root(p, 11) == 10); // renderer owner -> root, audio sibling 12 covered
  CHECK(application_root(p, 40) == 40); // never ascend to desktop shell
  CHECK((display_roots(p, {11, 12, 21, 31, 40}, 31) == std::vector<std::uint32_t>{10, 40}));
  p.push_back({50, 10, 5, "c:/discord/DiscordCanary.exe"});
  CHECK((display_roots(p, {11, 40, 50}, 31) == std::vector<std::uint32_t>{40}));
  CHECK(basename("C:\\Apps\\DiscordPTB.EXE") == "discordptb.exe");
  p.push_back({60, 1, 3, "c:/DiscordPTB.exe"});
  p.push_back({61, 60, 4, "c:/utility/worker.exe"});
  CHECK((display_roots(p, {40, 61, 99999}, 31) == std::vector<std::uint32_t>{40}));
  p.push_back({70, 1, 6, "c:/music/music.exe"});
  p.push_back({71, 70, 5, "c:/music/music.exe"}); // reused parent PID is newer
  CHECK(application_root(p, 71) == 71);
  p.push_back({80, 40, 5, "c:/plugin/plugin.exe"});
  CHECK((display_roots(p, {40, 80}, 31) == std::vector<std::uint32_t>{40}));
  p.push_back({81, 40, 0, ""}); // inaccessible child -> reject containing tree
  CHECK(display_roots(p, {40}, 31).empty());
  p.push_back({90, 1, 0, ""});
  p.push_back({91, 90, 8, "c:/music/music.exe"});
  CHECK(display_roots(p, {91}, 31).empty()); // protected/unverifiable live parent
  ProcessHistory history;
  auto remembered = history.update(p, 31);
  CHECK(denied_process(remembered, 61, 31));
  auto reused = p;
  for (auto& q : reused) if (q.pid == 60) q = {60, 1, 100, "c:/music/music.exe"};
  remembered = history.update(reused, 31);
  CHECK(denied_process(remembered, 61, 31)); // Discord's differently-named orphan remains excluded after parent PID reuse
  Timeline t;
  t.push({100, {0.25f, -0.25f, 0.5f, -0.5f}});
  auto output = t.take(99, 4);
  CHECK((output == std::vector<float>{0, 0, 0.25f, -0.25f, 0.5f, -0.5f, 0, 0}));
  CHECK((t.take(104, 2) == std::vector<float>{0, 0, 0, 0}));
  CHECK((mix({{0.75f, -0.75f}, {0.75f, -0.75f}}, 1) == std::vector<float>{1, -1}));
  {
    // Coarse Windows 10 timers (~15.6 ms passes plus snapshot work) must still keep real time.
    // Previously only one 10 ms quantum left per pass, so output fell behind and capture stopped.
    const std::uint64_t origin = 1000000000, delay = OutputClock::default_delay, pass = 186000; // 18.6 ms
    OutputClock clock(origin);
    std::uint64_t now = origin; int resyncs = 0; std::int64_t emitted = 0;
    for (int i = 0; i < 2000; ++i) { // ~37 s
      auto checked = now; now += pass;
      if (clock.resync(now)) ++resyncs;
      while (clock.ready(now, checked)) {
        auto start = clock.advance();
        CHECK(origin + static_cast<std::uint64_t>(start + OutputClock::quantum) * 10000000 / 48000 <= checked); // never audio newer than the check
        emitted += OutputClock::quantum;
      }
      if (now < origin + delay + pass) continue; // still inside the initial quarantine
      auto lag = static_cast<std::int64_t>(now - origin - delay) * 48000 / 10000000 - clock.frame();
      CHECK(lag >= 0 && lag < 48000 * 3 / 100); // stays within ~30 ms of real time
    }
    CHECK(resyncs == 0);
    CHECK(emitted == clock.frame() && emitted > 48000 * 36);
    // A multi-second stall (e.g. activating a new application's loopback) skips stale audio and continues.
    auto checked = now; now += 30000000; // 3 s
    CHECK(clock.resync(now));
    auto before = clock.frame();
    CHECK(!clock.ready(now, checked)); // audio from the stall is newer than the last exclusion check
    checked = now; now += pass;
    CHECK(!clock.resync(now));
    int burst = 0;
    while (clock.ready(now, checked)) { clock.advance(); ++burst; }
    CHECK(burst >= 1 && burst <= 13); // catch-up bursts stay within ~120 ms
    CHECK(clock.frame() > before);
    auto lag = static_cast<std::int64_t>(now - origin - delay) * 48000 / 10000000 - clock.frame();
    CHECK(lag >= 0 && lag < 48000 / 4);
    // Nothing is due before the quarantine elapses.
    OutputClock fresh(origin);
    CHECK(!fresh.ready(origin + delay, origin + delay));
    CHECK(fresh.ready(origin + delay + 100000, origin + delay));
  }
  std::cout << "{\"type\":\"test-result\",\"suite\":\"windows-audio-policy\",\"success\":true}\n";
  return 0;
} catch (const std::exception& e) {
  std::cerr << e.what() << '\n';
  std::cout << "{\"type\":\"test-result\",\"suite\":\"windows-audio-policy\",\"success\":false}\n";
  return 1;
}
}
