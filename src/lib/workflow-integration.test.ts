import { describe, it, expect } from "vitest";
import { Node, Edge } from "@xyflow/react";
import { FlowEngine } from "./engine";
import { NodeData } from "@/types";

function node(
  id: string,
  nodeType: NodeData["nodeType"],
  category: NodeData["category"],
  config: Record<string, unknown> = {},
): Node<NodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, nodeType, category, config },
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

describe("Workflow integration: linear pipeline", () => {
  const csv = "name,city\nAlice,Jakarta\nBob,Bandung";
  const parsedRows = [
    { name: "Alice", city: "Jakarta" },
    { name: "Bob", city: "Bandung" },
  ];

  // Manual Trigger -> Code Block -> CSV to JSON -> Text Formatter
  function linearFlow() {
    const nodes = [
      node("trigger", "manual-trigger", "trigger", { data: { csv } }),
      node("extract", "code-block", "action", {
        code: "return input.data.csv;",
      }),
      node("parse", "csv-to-json", "transform", {
        delimiter: ",",
        hasHeader: true,
      }),
      node("format", "text-formatter", "transform", {
        operation: "uppercase",
      }),
    ];
    const edges = [
      edge("trigger", "extract"),
      edge("extract", "parse"),
      edge("parse", "format"),
    ];
    return { nodes, edges };
  }

  it("passes data through all four nodes in order", async () => {
    const { nodes, edges } = linearFlow();
    const started: string[] = [];
    const errors: string[] = [];

    const results = await new FlowEngine().executeFlow(
      nodes,
      edges,
      (id) => started.push(id),
      undefined,
      (id) => errors.push(id),
    );

    expect(started).toEqual(["trigger", "extract", "parse", "format"]);
    expect(errors).toEqual([]);
    expect(results.get("trigger")?.output).toMatchObject({
      trigger: "manual",
      data: { csv },
    });
    expect(results.get("extract")?.output).toBe(csv);
    expect(results.get("parse")?.output).toEqual(parsedRows);
    expect(results.get("format")?.output).toBe(
      JSON.stringify(parsedRows).toUpperCase(),
    );
  });

  it("passes the same data through each step in step mode", async () => {
    const { nodes, edges } = linearFlow();
    const steps = [];
    for await (const step of new FlowEngine().executeStepByStep(nodes, edges))
      steps.push(step);

    expect(steps.map((s) => s.nodeId)).toEqual([
      "trigger",
      "extract",
      "parse",
      "format",
    ]);
    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(steps[2].input).toBe(csv);
    expect(steps[2].output).toEqual(parsedRows);
    expect(steps[3].input).toEqual(parsedRows);
    expect(steps[3].output).toBe(JSON.stringify(parsedRows).toUpperCase());
  });
});

describe("Workflow integration: split and converge", () => {
  // Trigger branches into two transforms that merge into one notification
  function splitFlow() {
    const nodes = [
      node("trigger", "manual-trigger", "trigger", {
        data: { amount: 100, customer: "Alice" },
      }),
      node("double", "math-operation", "transform", {
        operation: "multiply",
        operand: 2,
        path: "data.amount",
      }),
      node("pick", "object-mapper", "transform", {
        mapping: JSON.stringify({ name: "data.customer" }),
      }),
      node("notify", "notification", "output", { title: "Order processed" }),
    ];
    const edges = [
      edge("trigger", "double"),
      edge("trigger", "pick"),
      edge("double", "notify"),
      edge("pick", "notify"),
    ];
    return { nodes, edges };
  }

  it("runs both branches before the converging node, which runs once", async () => {
    const { nodes, edges } = splitFlow();
    const started: string[] = [];

    await new FlowEngine().executeFlow(nodes, edges, (id) => started.push(id));

    expect(started).toEqual(["trigger", "double", "pick", "notify"]);
  });

  it("delivers both branch outputs to the converging node", async () => {
    const { nodes, edges } = splitFlow();
    const errors: string[] = [];

    const results = await new FlowEngine().executeFlow(
      nodes,
      edges,
      undefined,
      undefined,
      (id) => errors.push(id),
    );

    expect(errors).toEqual([]);
    expect(results.get("notify")?.output).toMatchObject({
      notified: true,
      title: "Order processed",
      data: [{ data: { amount: 200, customer: "Alice" } }, { name: "Alice" }],
    });
  });

  it("does not let one branch mutate the shared trigger output", async () => {
    const { nodes, edges } = splitFlow();

    const results = await new FlowEngine().executeFlow(nodes, edges);

    expect(results.get("trigger")?.output).toMatchObject({
      data: { amount: 100, customer: "Alice" },
    });
  });
});

describe("Workflow integration: abort", () => {
  // trigger -> a -> b -> c
  function chainFlow() {
    const nodes = [
      node("trigger", "manual-trigger", "trigger"),
      node("a", "code-block", "action", { code: 'return "a";' }),
      node("b", "code-block", "action", { code: 'return "b";' }),
      node("c", "code-block", "action", { code: 'return "c";' }),
    ];
    const edges = [edge("trigger", "a"), edge("a", "b"), edge("b", "c")];
    return { nodes, edges };
  }

  it("stops all remaining nodes when abort() is called mid-flow", async () => {
    const { nodes, edges } = chainFlow();
    const engine = new FlowEngine();
    const started: string[] = [];
    const errors: string[] = [];

    const results = await engine.executeFlow(
      nodes,
      edges,
      (id) => started.push(id),
      (id) => {
        if (id === "a") engine.abort();
      },
      (id) => errors.push(id),
    );

    expect(started).toEqual(["trigger", "a"]);
    expect(results.get("a")?.output).toBe("a");
    expect(results.has("b")).toBe(false);
    expect(results.has("c")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("runs the full flow on the next execution after an abort", async () => {
    const { nodes, edges } = chainFlow();
    const engine = new FlowEngine();

    await engine.executeFlow(nodes, edges, undefined, (id) => {
      if (id === "a") engine.abort();
    });
    const results = await engine.executeFlow(nodes, edges);

    expect(results.get("c")?.output).toBe("c");
  });
});