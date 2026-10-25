import type { Language } from './language.js';
import type { Currency, Governorate, ShipmentStatus } from './shipments.js';
import type { ClientApp, UserRole } from './roles.js';

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** The authenticated user as returned by the API. Never contains secrets. */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  language: Language;
  merchant: { businessName: string } | null;
}

export interface SessionInfo {
  id: string;
  clientApp: ClientApp;
  expiresAt: string;
}

export interface LoginResponse {
  user: AuthUser;
  session: SessionInfo;
  /**
   * Opaque session token for Bearer authentication. Omitted when the client
   * requested cookie transport (the token is then set as an httpOnly cookie).
   */
  token?: string;
}

export interface MeResponse {
  user: AuthUser;
  session: SessionInfo;
}

export interface MessageResponse {
  ok: true;
}

export interface UserListItem {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: string;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  database: 'up' | 'down';
}

/** HTTP header a browser client sends to receive the session as an httpOnly cookie. */
export const AUTH_TRANSPORT_HEADER = 'x-auth-transport';
export const SESSION_COOKIE_NAME = 'coobra_session';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ShipmentPerson {
  id: string;
  fullName: string;
  phone: string | null;
}

export interface ShipmentMerchant extends ShipmentPerson {
  businessName: string;
}

/** Compact shipment row used in lists. Money values are decimal strings (e.g. "120.00"). */
export interface ShipmentListItem {
  id: string;
  trackingNumber: string;
  status: ShipmentStatus;
  recipientName: string;
  recipientPhone: string;
  governorate: Governorate;
  city: string;
  codAmount: string;
  deliveryFee: string | null;
  currency: Currency;
  merchant: ShipmentMerchant;
  driver: ShipmentPerson | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentHistoryEntry {
  id: string;
  fromStatus: ShipmentStatus | null;
  toStatus: ShipmentStatus;
  note: string | null;
  actor: { id: string; fullName: string; role: UserRole } | null;
  /** For assignment entries: the driver assigned. */
  driver: ShipmentPerson | null;
  createdAt: string;
}

export interface CodCollectionRecord {
  collected: boolean;
  expectedAmount: string;
  collectedAmount: string;
  currency: Currency;
  recordedAt: string;
  driver: ShipmentPerson | null;
}

export interface ShipmentDetails extends ShipmentListItem {
  recipientPhoneAlt: string | null;
  addressLine: string;
  landmark: string | null;
  recipientNotes: string | null;
  merchantNotes: string | null;
  createdBy: { id: string; fullName: string; role: UserRole } | null;
  creatorRole: UserRole;
  failureReason: string | null;
  cancellationReason: string | null;
  returnReason: string | null;
  deliveryAttempts: number;
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cod: CodCollectionRecord | null;
  history: ShipmentHistoryEntry[];
  /** Concurrency token; changes on every update. */
  version: number;
}

export type ShipmentStatusCounts = Record<ShipmentStatus, number>;

export interface ShipmentSummary {
  counts: ShipmentStatusCounts;
  total: number;
}

export interface MerchantOption {
  id: string;
  fullName: string;
  businessName: string;
  phone: string | null;
  email: string;
}

export interface DriverOption {
  id: string;
  fullName: string;
  phone: string | null;
  activeShipments: number;
}
