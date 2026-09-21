"""Maximum bipartite b-matching via Dinic.

Used for the downlink sub-problem: every downlink job is bound to exactly one
satellite, so the only question is which contact slots it gets. That makes the
assignment a pure flow problem, small enough to solve exactly on every replan.
"""
from __future__ import annotations

from collections import deque


class MaxFlow:
    """Dinic's algorithm on a small integer-capacity network."""

    def __init__(self, node_count: int) -> None:
        self.n = node_count
        self.graph: list[list[int]] = [[] for _ in range(node_count)]
        # edges are flat triples (to, capacity, reverse_index)
        self.to: list[int] = []
        self.cap: list[int] = []

    def add_edge(self, u: int, v: int, capacity: int) -> int:
        edge_id = len(self.to)
        self.graph[u].append(edge_id)
        self.to.append(v)
        self.cap.append(capacity)
        self.graph[v].append(edge_id + 1)
        self.to.append(u)
        self.cap.append(0)
        return edge_id

    def _levels(self, source: int, sink: int) -> list[int] | None:
        level = [-1] * self.n
        level[source] = 0
        queue = deque([source])
        while queue:
            u = queue.popleft()
            for edge_id in self.graph[u]:
                v = self.to[edge_id]
                if self.cap[edge_id] > 0 and level[v] < 0:
                    level[v] = level[u] + 1
                    queue.append(v)
        return level if level[sink] >= 0 else None

    def _augment(self, u: int, sink: int, pushed: int, level: list[int],
                 iters: list[int]) -> int:
        if u == sink:
            return pushed
        while iters[u] < len(self.graph[u]):
            edge_id = self.graph[u][iters[u]]
            v = self.to[edge_id]
            if self.cap[edge_id] > 0 and level[v] == level[u] + 1:
                got = self._augment(v, sink, min(pushed, self.cap[edge_id]), level, iters)
                if got:
                    self.cap[edge_id] -= got
                    self.cap[edge_id ^ 1] += got
                    return got
            iters[u] += 1
        return 0

    def run(self, source: int, sink: int) -> int:
        total = 0
        while True:
            level = self._levels(source, sink)
            if level is None:
                return total
            iters = [0] * self.n
            while True:
                pushed = self._augment(source, sink, 1 << 30, level, iters)
                if not pushed:
                    break
                total += pushed

    def flow_on(self, edge_id: int) -> int:
        """Flow pushed through an edge added with :meth:`add_edge`."""
        return self.cap[edge_id ^ 1]

    def reachable_from(self, source: int) -> set[int]:
        """Nodes still reachable in the residual network (min-cut source side)."""
        seen = {source}
        queue = deque([source])
        while queue:
            u = queue.popleft()
            for edge_id in self.graph[u]:
                v = self.to[edge_id]
                if self.cap[edge_id] > 0 and v not in seen:
                    seen.add(v)
                    queue.append(v)
        return seen
