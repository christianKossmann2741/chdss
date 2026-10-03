#include "../native/windows/policy.hpp"
#include <iostream>
#include <stdexcept>
using namespace chdss;
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
int main() { try {
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
  std::cout << "{\"type\":\"test-result\",\"suite\":\"windows-audio-policy\",\"success\":true}\n";
  return 0;
} catch (const std::exception& e) {
  std::cerr << e.what() << '\n';
  std::cout << "{\"type\":\"test-result\",\"suite\":\"windows-audio-policy\",\"success\":false}\n";
  return 1;
}
}
