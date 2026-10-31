import { create } from 'zustand';
import type { ImpersonationEndReason, ImpersonationInfo } from '@coobra/shared';

/**
 * Per-tab impersonation state (ADR 0003 §8.2). Only a marker lives in `sessionStorage`, which
 * belongs to this tab alone: other tabs of the same app keep the real session, and nothing
 * secret is stored (the session itself is the separate httpOnly impersonation cookie).
 *
 * - none: an ordinary tab.
 * - active: every API call sends the impersonation header (and never falls back to the real
 *   session: a 401 ends the impersonation in this tab).
 * - ended: the tab only shows "session ended", even after a reload.
 */
export type ImpersonationMode = 'none' | 'active' | 'ended';
/** LOST: the API no longer accepts the impersonation (ended elsewhere, revoked, expired). */
export type ImpersonationEndedReason = ImpersonationEndReason | 'LOST';

const MARKER = 'coobra.impersonation';

function tabStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readMarker(): ImpersonationMode {
  const value = tabStorage()?.getItem(MARKER);
  return value === 'active' || value === 'ended' ? value : 'none';
}

function writeMarker(mode: ImpersonationMode) {
  try {
    if (mode === 'none') tabStorage()?.removeItem(MARKER);
    else tabStorage()?.setItem(MARKER, mode);
  } catch {
    // Without sessionStorage a reload simply ends the impersonation in this tab.
  }
}

interface ImpersonationState {
  mode: ImpersonationMode;
  info: ImpersonationInfo | null;
  /** Local time when `info.serverNow` was received (the countdown uses the server's clock). */
  receivedAt: number;
  endedReason: ImpersonationEndedReason | null;
  activate: (info: ImpersonationInfo) => void;
  update: (info: ImpersonationInfo) => void;
  end: (reason: ImpersonationEndedReason) => void;
  /** Leaves the ended state (the tab becomes an ordinary one). */
  clear: () => void;
}

export const useImpersonationStore = create<ImpersonationState>((set, get) => ({
  mode: readMarker(),
  info: null,
  receivedAt: 0,
  endedReason: null,
  activate: (info) => {
    writeMarker('active');
    set({ mode: 'active', info, receivedAt: Date.now(), endedReason: null });
  },
  update: (info) => set({ info, receivedAt: Date.now() }),
  end: (reason) => {
    if (get().mode !== 'active') return;
    writeMarker('ended');
    set({ mode: 'ended', info: null, endedReason: reason });
  },
  clear: () => {
    writeMarker('none');
    set({ mode: 'none', info: null, endedReason: null });
  },
}));

/** The path the admin console opens; that tab never loads the browser's real session. */
export const IMPERSONATE_PATH = '/impersonate';

export function isHandoffTab(): boolean {
  return typeof window !== 'undefined' && window.location?.pathname === IMPERSONATE_PATH;
}
