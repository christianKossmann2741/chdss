#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
namespace chdss {
enum class Scope { application, display };
struct Source { Scope scope; std::uintptr_t window; };
inline std::uint64_t decimal(const std::string& s) {
  if (s.empty()) throw std::runtime_error("Missing source ID");
  std::uint64_t n = 0;
  for (char c : s) {
    if (c < '0' || c > '9' || n > (UINT64_MAX - (c - '0')) / 10)
      throw std::runtime_error("Source ID must be decimal and fit uint64");
    n = n * 10 + (c - '0');
  }
  return n;
}
inline Source parse_source(const std::string& s) {
  auto a = s.find(':'); auto b = a == std::string::npos ? a : s.find(':', a + 1);
  if (a == std::string::npos || b == std::string::npos || s.find(':', b + 1) != std::string::npos)
    throw std::runtime_error("Expected window:<decimal HWND>:<id> or screen:<id>:<id>");
  auto kind = s.substr(0, a); auto n = decimal(s.substr(a + 1, b - a - 1));
  decimal(s.substr(b + 1));
  if (kind == "screen") return {Scope::display, 0};
  if (kind != "window" || n == 0 || n > std::numeric_limits<std::uintptr_t>::max())
    throw std::runtime_error("Invalid window source");
  return {Scope::application, static_cast<std::uintptr_t>(n)};
}
struct Process { std::uint32_t pid, parent; std::uint64_t created; std::string image; bool excluded = false; };
using Processes = std::vector<Process>;
inline std::string lower(std::string s) {
  for (auto& c : s) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  return s;
}
inline std::string basename(const std::string& path) {
  return lower(path.substr(path.find_last_of("/\\") + 1));
}
inline const Process* process(const Processes& p, std::uint32_t id) {
  auto i = std::find_if(p.begin(), p.end(), [id](auto& x) { return x.pid == id; });
  return i == p.end() ? nullptr : &*i;
}
inline bool verified(const Process* p) { return p && p->created && !p->image.empty(); }
inline bool parent_edge(const Process* child, const Process* parent) {
  return child && parent && child->parent == parent->pid && child->created && parent->created && parent->created < child->created;
}
inline std::uint32_t application_root(const Processes& ps, std::uint32_t pid) {
  auto p = process(ps, pid);
  if (!verified(p)) throw std::runtime_error("Cannot verify application process identity");
  for (std::size_t n = 0; n < ps.size(); ++n) {
    auto parent = process(ps, p->parent);
    // Full executable path plus creation time: never broaden into Explorer, launchers,
    // another installation, a reused parent PID, or an unknown/protected process.
    if (!verified(parent) || !parent_edge(p, parent) || lower(parent->image) != lower(p->image)) return p->pid;
    p = parent;
  }
  throw std::runtime_error("Invalid process ancestry");
}
inline bool descendant(const Processes& ps, std::uint32_t child, std::uint32_t root) {
  for (std::size_t n = 0; n <= ps.size(); ++n) {
    if (child == root) return true;
    auto p = process(ps, child);
    auto parent = p ? process(ps, p->parent) : nullptr;
    if (!parent_edge(p, parent)) return false;
    child = parent->pid;
  }
  return false;
}
inline bool denied_name(const std::string& image) {
  auto n = basename(image);
  return n == "discord.exe" || n == "discordptb.exe" || n == "discordcanary.exe" ||
    n == "chdss.exe" || n == "chdss-audio.exe";
}
inline bool denied_process(const Processes& ps, std::uint32_t id, std::uint32_t own_root) {
  if (descendant(ps, id, own_root)) return true;
  for (std::size_t n = 0; n <= ps.size(); ++n) {
    auto p = process(ps, id);
    // Unknown ancestry is denied, not optimistically accepted.
    if (!verified(p) || p->excluded || denied_name(p->image)) return true;
    auto parent = process(ps, p->parent);
    if (parent && !verified(parent) && p->parent != 0) return true;
    if (!parent_edge(p, parent)) return false;
    id = parent->pid;
  }
  return true;
}
class ProcessHistory {
  std::map<std::uint32_t, Process> history_;
public:
  Processes update(const Processes& current, std::uint32_t own_root) {
    for (auto p : current) {
      auto old = history_.find(p.pid);
      if (old != history_.end() && p.created && p.created == old->second.created)
        p.excluded = old->second.excluded;
      history_[p.pid] = std::move(p);
    }
    if (history_.size() > 100000) throw std::runtime_error("Process identity history exceeds safety limit");
    Processes ps; ps.reserve(history_.size());
    for (auto& p : history_) ps.push_back(p.second);
    for (auto& p : ps) {
      if (verified(&p) && denied_process(ps, p.pid, own_root)) {
        p.excluded = true; history_[p.pid].excluded = true;
      }
    }
    return ps;
  }
};
inline bool safe_tree(const Processes& ps, std::uint32_t root, std::uint32_t own_root) {
  if (!verified(process(ps, root))) return false;
  for (auto& p : ps) {
    auto child = p.pid;
    // Missing creation times cannot prove a child is outside this tree.
    // Conservatively follow its parent ID; known PID-reuse edges still stop.
    bool possible_child = false;
    for (std::size_t n = 0; n <= ps.size(); ++n) {
      if (child == root) { possible_child = true; break; }
      auto entry = process(ps, child);
      auto parent = entry ? process(ps, entry->parent) : nullptr;
      if (!entry || !parent || (entry->created && parent->created && parent->created >= entry->created)) break;
      child = parent->pid;
    }
    if (possible_child && denied_process(ps, p.pid, own_root)) return false;
  }
  return true;
}
inline std::vector<std::uint32_t> display_roots(const Processes& ps, const std::vector<std::uint32_t>& active, std::uint32_t own_pid) {
  auto own_root = application_root(ps, own_pid);
  std::vector<std::uint32_t> roots;
  for (auto pid : active) {
    if (denied_process(ps, pid, own_root)) continue;
    auto root = application_root(ps, pid);
    if (safe_tree(ps, root, own_root)) roots.push_back(root);
  }
  std::sort(roots.begin(), roots.end());
  roots.erase(std::unique(roots.begin(), roots.end()), roots.end());
  auto all = roots;
  roots.erase(std::remove_if(roots.begin(), roots.end(), [&](auto root) {
    for (auto other : all) if (other != root && descendant(ps, root, other)) return true;
    return false;
  }), roots.end());
  return roots;
}
struct Packet { std::int64_t start; std::vector<float> samples; };
class Timeline {
  std::vector<Packet> packets_;
public:
  void push(Packet packet) {
    if (packet.samples.size() % 2) throw std::runtime_error("Invalid stereo packet");
    packets_.push_back(std::move(packet));
    if (packets_.size() > 512) throw std::runtime_error("Capture backlog exceeds safety limit");
  }
  std::vector<float> take(std::int64_t start, std::size_t frames) {
    std::vector<float> out(frames * 2, 0.0f);
    auto end = start + static_cast<std::int64_t>(frames);
    for (auto& packet : packets_) {
      auto packet_end = packet.start + static_cast<std::int64_t>(packet.samples.size() / 2);
      for (auto frame = std::max(start, packet.start); frame < std::min(end, packet_end); ++frame)
        for (int c = 0; c < 2; ++c)
          out[(frame - start) * 2 + c] += packet.samples[(frame - packet.start) * 2 + c];
    }
    packets_.erase(std::remove_if(packets_.begin(), packets_.end(), [&](auto& p) {
      return p.start + static_cast<std::int64_t>(p.samples.size() / 2) <= end;
    }), packets_.end());
    return out;
  }
};
inline std::vector<float> mix(const std::vector<std::vector<float>>& inputs, std::size_t frames) {
  std::vector<float> out(frames * 2, 0.0f);
  for (auto& input : inputs) {
    if (input.size() != out.size()) throw std::runtime_error("Invalid stereo block");
    for (std::size_t i = 0; i < out.size(); ++i) out[i] += input[i];
  }
  for (auto& sample : out) sample = std::max(-1.0f, std::min(1.0f, sample));
  return out;
}
}
