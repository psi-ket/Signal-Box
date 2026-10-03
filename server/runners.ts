/**
 * Online runners. A personal runner (token owned by a user) runs only that user's agents;
 * the optional shared host runner (token with no owner, created with --host-runner) runs
 * agents for anyone. A newer connection with the same token replaces the older one.
 */
import type { KeyVendor, ProviderId, ProviderInfo, RunnerView } from "../shared/protocol.ts";
import type { HubToRunner, RunnerToHub } from "../shared/runnerProtocol.ts";
import type { Db } from "./db.ts";
import { VENDOR_FOR_PROVIDER } from "./keys.ts";
import type { Logger } from "./log.ts";
import type { RunnerSocket } from "./transport.ts";

export interface RunnerLink {
  id: string; // socket id
  tokenId: string;
  ownerId: string | null;
  ownerName: string | null;
  shared: boolean;
  name: string;
  platform: string;
  providers: ProviderInfo[];
  /** Masked key status per participant, as last reported by the runner. */
  keys: Map<string, { vendor: KeyVendor; masked: string; models: { id: string; label: string }[]; checkedAt: number }[]>;
  send(msg: HubToRunner): void;
  close(code: number, reason: string): void;
}

export interface RegistryEvents {
  /** The set of online runners for this owner (null = shared) changed. */
  changed(ownerId: string | null, link: RunnerLink, online: boolean): void;
}

export class RunnerRegistry {
  private links = new Map<string, RunnerLink>();
  private sockets = new Map<string, RunnerSocket>();

  constructor(
    private db: Db,
    private log: Logger,
    private events: RegistryEvents,
  ) {}

  socketOpened(sock: RunnerSocket) {
    this.sockets.set(sock.id, sock);
  }

  /** Registers a runner after its hello. Returns the link, or null if the token vanished. */
  hello(sock: RunnerSocket, msg: Extract<RunnerToHub, { type: "runner.hello" }>): RunnerLink | null {
    const row = this.db.getRunnerToken(sock.tokenId);
    if (!row) {
      sock.close(4001, "runner token revoked");
      return null;
    }
    for (const old of [...this.links.values()].filter((l) => l.tokenId === sock.tokenId && l.id !== sock.id)) {
      old.close(4000, "replaced by a newer connection with the same token");
      this.remove(old.id);
    }
    const owner = row.user_id ? this.db.getUser(row.user_id) : undefined;
    const link: RunnerLink = {
      id: sock.id,
      tokenId: sock.tokenId,
      ownerId: owner?.id ?? null,
      ownerName: owner?.username ?? null,
      shared: !row.user_id,
      name: msg.name,
      platform: msg.platform,
      providers: msg.providers,
      keys: new Map(),
      send: (m) => sock.send(m),
      close: (c, r) => sock.close(c, r),
    };
    this.links.set(sock.id, link);
    this.db.touchRunner(sock.tokenId);
    link.send({ type: "runner.welcome", runnerId: link.id, owner: owner ? { id: owner.id, name: owner.username } : null, shared: link.shared });
    this.log.info("runner online", { runner: link.name, owner: link.ownerName ?? "(shared)", providers: msg.providers.filter((p) => p.available || p.byoReady).map((p) => p.id) });
    this.events.changed(link.ownerId, link, true);
    return link;
  }

  get(id: string) {
    return this.links.get(id);
  }

  bySocket(sockId: string) {
    return this.links.get(sockId);
  }

  remove(sockId: string) {
    this.sockets.delete(sockId);
    const link = this.links.get(sockId);
    if (!link) return;
    this.links.delete(sockId);
    this.log.info("runner offline", { runner: link.name, owner: link.ownerName ?? "(shared)" });
    this.events.changed(link.ownerId, link, false);
  }

  revokeToken(tokenId: string) {
    for (const l of [...this.links.values()]) if (l.tokenId === tokenId) {
      l.close(4001, "runner token revoked");
      this.remove(l.id);
    }
  }

  updateProviders(link: RunnerLink, providers: ProviderInfo[]) {
    link.providers = providers;
    this.events.changed(link.ownerId, link, true);
  }

  /** The runner that runs this user's agents: their newest personal runner, else the shared one. */
  forUser(userId: string): RunnerLink | undefined {
    const own = [...this.links.values()].filter((l) => l.ownerId === userId);
    return own.at(-1) ?? this.shared();
  }

  personal(userId: string): RunnerLink[] {
    return [...this.links.values()].filter((l) => l.ownerId === userId);
  }

  shared(): RunnerLink | undefined {
    return [...this.links.values()].find((l) => l.shared);
  }

  all(): RunnerLink[] {
    return [...this.links.values()];
  }

  hasKey(runnerId: string, participantId: string, provider: ProviderId) {
    const vendor = VENDOR_FOR_PROVIDER[provider];
    const k = vendor ? this.links.get(runnerId)?.keys.get(participantId)?.find((x) => x.vendor === vendor) : undefined;
    return k ? { models: k.models } : null;
  }

  static view(l: RunnerLink): RunnerView {
    return { id: l.id, name: l.name, ownerId: l.ownerId, ownerName: l.ownerName, shared: l.shared, platform: l.platform, providers: l.providers };
  }
}
