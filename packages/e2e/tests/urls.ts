/** Ports of the isolated end-to-end stack (override with E2E_*_PORT). */
export const E2E_PORTS = {
  api: Number(process.env.E2E_API_PORT ?? 4100),
  admin: Number(process.env.E2E_ADMIN_PORT ?? 3100),
  merchant: Number(process.env.E2E_MERCHANT_PORT ?? 8182),
  driver: Number(process.env.E2E_DRIVER_PORT ?? 8181),
};

export const URLS = {
  api: `http://localhost:${E2E_PORTS.api}`,
  admin: `http://localhost:${E2E_PORTS.admin}`,
  merchant: `http://localhost:${E2E_PORTS.merchant}`,
  driver: `http://localhost:${E2E_PORTS.driver}`,
};
