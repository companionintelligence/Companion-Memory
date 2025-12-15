import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, List, Optional, Tuple

import rustworkx as rx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# --- Pydantic Models ---


class PathResponse(BaseModel):
    source: str
    target: str
    distance: float
    path_nodes: List[str]


# --- Graph Logic ---


class GraphManager:
    def __init__(self) -> None:
        self.graph: rx.PyDiGraph = rx.PyDiGraph()
        self.node_map: Dict[str, int] = {}
        self.reverse_map: Dict[int, str] = {}

    def add_edge(self, start: str, end: str, weight: float) -> None:
        if start not in self.node_map:
            s_idx = self.graph.add_node(start)
            self.node_map[start] = s_idx
            self.reverse_map[s_idx] = start

        if end not in self.node_map:
            e_idx = self.graph.add_node(end)
            self.node_map[end] = e_idx
            self.reverse_map[e_idx] = end

        u = self.node_map[start]
        v = self.node_map[end]
        self.graph.add_edge(u, v, weight)

    def get_shortest_path(
        self, start_label: str, end_label: str
    ) -> Optional[PathResponse]:
        if start_label not in self.node_map or end_label not in self.node_map:
            return None

        start_idx = self.node_map[start_label]
        end_idx = self.node_map[end_label]

        try:
            # Get path sequence
            paths = rx.dijkstra_shortest_paths(
                self.graph, start_idx, weight_fn=lambda x: float(x), target=end_idx
            )

            if end_idx not in paths:
                return None

            node_indices = paths[end_idx]

            # Calculate total distance based on path (Alternatively, use
            # dijkstra_shortest_path_lengths for just the cost)
            distance = 0.0
            for i in range(len(node_indices) - 1):
                # get_edge_data returns the weight we stored
                u, v = node_indices[i], node_indices[i + 1]
                # Note: rustworkx allows multiple edges; we assume simple graph
                # here or take first
                edge_data = self.graph.get_edge_data(u, v)
                distance += float(edge_data)

            path_labels = [self.reverse_map[idx] for idx in node_indices]

            return PathResponse(
                source=start_label,
                target=end_label,
                distance=distance,
                path_nodes=path_labels,
            )
        except Exception:
            return None


# --- Database & Lifespan Logic ---

# 1. Instantiate the manager globally
graph_manager = GraphManager()


async def mock_db_fetch() -> List[Tuple[str, str, float]]:
    """Simulate a slow DB query."""
    print("Hydrating graph from DB...")
    await asyncio.sleep(2)  # Simulate network latency
    # Return mock rows: (Source, Target, Weight)
    return [
        ("A", "B", 1.0),
        ("B", "C", 2.0),
        ("C", "D", 1.0),
        ("A", "E", 10.0),
    ]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # --- STARTUP PHASE ---
    # This block runs BEFORE the server accepts requests.
    try:
        data = await mock_db_fetch()
        for start, end, weight in data:
            graph_manager.add_edge(start, end, weight)
        print(f"Graph hydration complete. Loaded {len(data)} edges.")
    except Exception as e:
        print(f"CRITICAL: Failed to load graph data: {e}")
        # Raising an exception here will prevent the server from starting
        raise e

    yield  # Server is running and accepting requests now

    # --- SHUTDOWN PHASE ---
    # Clean up resources if needed
    print("Shutting down...")


# 2. Pass lifespan to FastAPI
app = FastAPI(lifespan=lifespan)

# --- Endpoints ---


@app.get("/health")
def health_check() -> Dict[str, str]:
    """Simple probe to verify app is awake."""
    return {"status": "ok"}


@app.get("/path/{start}/{end}")
def get_path(start: str, end: str) -> PathResponse:
    res = graph_manager.get_shortest_path(start, end)
    if not res:
        raise HTTPException(status_code=404, detail="Path not found")
    return res
