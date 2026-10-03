import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DEMO_TASKS } from "../../../shared/demoTasks.ts";
import type { ProviderId, RoomState, RunnerView } from "../../../shared/protocol.ts";
import type { MyKey } from "../useSite.ts";

export function NewSession({
  state,
  runner,
  myKeys,
  onCreate,
  onManageKeys,
}: {
  state: RoomState;
  /** The runner your agents will run on (yours, else the shared host runner). */
  runner: RunnerView | undefined;
  myKeys: MyKey[];
  onCreate: (title: string, task: string, provider: ProviderId, model: string | undefined, ownKey: boolean) => void;
  onManageKeys: () => void;
}) {
  const providers = runner?.providers ?? [];
  const usable = (p: RunnerView["providers"][number]) => p.available || (p.byoReady && myKeys.some((k) => k.vendor === p.byoVendor));
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<ProviderId>(providers.find(usable)?.id ?? "claude");
  useEffect(() => {
    if (!providers.some((p) => p.id === provider)) setProvider(providers.find(usable)?.id ?? "claude");
  }, [runner?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = providers.find((p) => p.id === provider);
  const myKey = info?.byoVendor && info.byoReady ? myKeys.find((k) => k.vendor === info.byoVendor) : undefined;
  const [billing, setBilling] = useState<"host" | "own">("host");
  useEffect(() => setBilling(info?.available ? "host" : myKey ? "own" : "host"), [provider, info?.available, !!myKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = useMemo(() => (billing === "own" && myKey ? myKey.models : (info?.models ?? [])), [billing, myKey, info]);
  const [model, setModel] = useState("");
  useEffect(() => {
    const def = info?.defaultModel;
    setModel(models.some((m) => m.id === def) ? def! : (models[0]?.id ?? ""));
  }, [models, info?.defaultModel]);

  const canRun = !!runner && (billing === "own" ? !!myKey : !!info?.available);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !task.trim() || !canRun) return;
    onCreate(title.trim(), task.trim(), provider, model || undefined, billing === "own");
    setTitle("");
    setTask("");
  };

  const fill = (i: number) => {
    const d = DEMO_TASKS[i]!;
    setTitle(d.title);
    setTask(provider === "mock" ? d.mock : d.prompt);
  };

  if (!runner)
    return (
      <section className="box newsession">
        <h2 className="box__title">spawn agent</h2>
        <p className="off">○ no runner connected</p>
        <p className="muted small">Your agents run on your own machine. Go back to the rooms page, add a runner under "your runners", and run the command it shows. This panel unlocks as soon as it connects.</p>
      </section>
    );

  return (
    <form className="box newsession" onSubmit={submit}>
      <h2 className="box__title">spawn agent</h2>
      <p className="muted small">
        runs on <b className="ok">{runner.name}</b>
        {runner.shared ? " (shared host runner)" : ""}
      </p>
      <div className="row2">
        <label>
          <span>agent</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!usable(p) && !(p.byoReady && p.byoVendor)}>
                {p.label}
                {!usable(p) ? (p.byoReady && p.byoVendor ? " (needs your key)" : " (unavailable)") : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label === m.id ? m.id : `${m.label} (${m.id})`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {info?.byoVendor && info.byoReady ? (
        <div className="billing" role="radiogroup" aria-label="who pays">
          <span className="muted small">bill:</span>
          <label className="radio">
            <input type="radio" name="billing" checked={billing === "host"} disabled={!info.available} onChange={() => setBilling("host")} />
            runner login ({info.available ? info.auth : "not set up"})
          </label>
          <label className="radio">
            <input type="radio" name="billing" checked={billing === "own"} disabled={!myKey} onChange={() => setBilling("own")} />
            my key {myKey ? myKey.masked : ""}
          </label>
          {!myKey && (
            <button type="button" className="ghost small" onClick={onManageKeys}>
              add {info.byoVendor} key
            </button>
          )}
        </div>
      ) : (
        info && <p className="muted small">auth: {info.available ? info.auth : info.note}</p>
      )}
      <label>
        <span>name</span>
        <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="storage-layer" required />
      </label>
      <label>
        <span>task</span>
        <textarea value={task} maxLength={4000} rows={4} onChange={(e) => setTask(e.target.value)} placeholder="what should this agent build?" required />
      </label>
      <div className="demo">
        <span className="muted">demo:</span>
        {DEMO_TASKS.map((d, i) => (
          <button type="button" className="ghost small" key={d.title} onClick={() => fill(i)}>
            {d.title}
          </button>
        ))}
      </div>
      <button type="submit" disabled={state.ended || !title.trim() || !task.trim() || !canRun}>
        spawn
      </button>
    </form>
  );
}
