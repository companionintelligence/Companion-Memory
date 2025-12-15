from typing import Dict, List, Optional

import rustworkx as rx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# --- Pydantic Models ---

class RootResponse(BaseModel):
    service: str
    status: str

class PathResponse(BaseModel):
    source: str
    target: str
    distance: float
    path_nodes: List[str]

# --- Graph Logic ---

class GraphManager:
    """
    Encapsulates the rustworkx graph and helper methods for node-string mapping.
    """
    def __init__(self) -> None:
        # PyDiGraph is a directed graph.
        # Type hints: PyDiGraph[NodePayload, EdgePayload]
        self.graph: rx.PyDiGraph = rx.PyDiGraph()
        self.node_map: Dict[str, int] = {}  # Maps "Label" -> NodeIndex
        self.reverse_map: Dict[int, str] = {} # Maps NodeIndex -> "Label"

    def add_node(self, label: str) -> int:
        if label in self.node_map:
            return self.node_map[label]

        idx = self.graph.add_node(label)
        self.node_map[label] = idx
        self.reverse_map[idx] = label
        return idx

    def add_edge(self, start: str, end: str, weight: float) -> int:
        u = self.add_node(start)
        v = self.add_node(end)
        return self.graph.add_edge(u, v, weight)

    def get_shortest_path(self, start_label: str, end_label: str) -> Optional[PathResponse]:
        if start_label not in self.node_map or end_label not in self.node_map:
            return None

        start_idx = self.node_map[start_label]
        end_idx = self.node_map[end_label]

        # rustworkx.dijkstra_shortest_paths returns a Dictionary of {target_node_index: distance}
        # To get the specific path, we can use dijkstra_shortest_path_lengths for distance
        # and checking paths, or use the standard shortest_path method if weights are 1.
        # For weighted graphs, `dijkstra_shortest_paths` is robust.

        try:
            # Compute path using Dijkstra. Returns Path object.
            # weight_fn is a lambda extracting the edge weight.
            path_indices = rx.dijkstra_shortest_path_lengths(
                self.graph, start_idx, lambda x: float(x), goal=end_idx
            )

            if end_idx not in path_indices:
                return None

            distance = path_indices[end_idx]

            # Reconstruct the actual path nodes
            # rustworkx.dijkstra_shortest_paths just gives lengths.
            # We use `dijkstra_shortest_paths` specifically to get the sequence:
            full_paths = rx.dijkstra_shortest_paths(
                self.graph, start_idx, weight_fn=lambda x: float(x), target=end_idx
            )

            # full_paths[end_idx] is a list of node indices
            node_indices = full_paths[end_idx]
            path_labels = [self.reverse_map[idx] for idx in node_indices]

            return PathResponse(
                source=start_label,
                target=end_label,
                distance=distance,
                path_nodes=path_labels
            )

        except Exception:
            return None

# --- Application Setup ---

app = FastAPI()
graph_manager = GraphManager()

# Populate Mock Data on Startup
# Creating a graph: A -> B -> C -> D, and a shortcut A -> D
# A -> B (1.0)
# B -> C (2.0)
# C -> D (1.0)  => Total A->D via C = 4.0
# A -> D (10.0) => Direct is slower
# A -> E (1.0)
@app.on_event("startup")
def startup_event() -> None:
    graph_manager.add_edge("A", "B", 1.0)
    graph_manager.add_edge("B", "C", 2.0)
    graph_manager.add_edge("C", "D", 1.0)
    graph_manager.add_edge("A", "D", 10.0) # Expensive direct path
    graph_manager.add_edge("A", "E", 1.0)
    print("Graph initialized with mock data.")

# --- Endpoints ---

@app.get("/")
def read_root() -> RootResponse:
    return RootResponse(service="Graph App", status="Running")

@app.get("/path/{start_node}/{end_node}")
def get_shortest_path(start_node: str, end_node: str) -> PathResponse:
    result = graph_manager.get_shortest_path(start_node, end_node)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No path found between {start_node} and {end_node}"
        )

    return result
