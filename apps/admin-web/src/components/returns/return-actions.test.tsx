// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ShipmentReturnInfo } from '@coobra/shared';
import { renderWithProviders } from '@/test/render';
import { ReturnInfoBlock } from './return-actions';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(async () => [
    { id: 'driver-1', fullName: 'Driver One', phone: '0599000001', activeShipments: 0 },
  ]),
}));

const info = (overrides: Partial<ShipmentReturnInfo> = {}): ShipmentReturnInfo => ({
  id: 'return-1',
  requestedAt: '2026-10-26T10:00:00.000Z',
  requestedBy: { id: 'merchant-1', fullName: 'Merchant' },
  requestReason: 'Customer cancelled',
  approvedAt: null,
  approvedBy: null,
  returnDriver: null,
  feeStatus: 'SET',
  feeAmount: '10.00',
  feeReason: 'Return fee from the pricing rule',
  feePolicy: 'RETURN_ONLY',
  deliveryCharge: '0.00',
  totalCharge: '10.00',
  completedAt: null,
  closedAt: null,
  ...overrides,
});

const block = (shipmentStatus: string, returnInfo: ShipmentReturnInfo) => (
  <ReturnInfoBlock
    shipmentId="shipment-1"
    shipmentStatus={shipmentStatus}
    info={returnInfo}
    canApprove
    canDecideFee
    invalidate={[]}
  />
);

describe('ReturnInfoBlock', () => {
  it('offers to approve a requested return', () => {
    renderWithProviders(block('RETURN_REQUESTED', info()));
    expect(screen.getByRole('button', { name: 'Approve return' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change return driver' })).toBeNull();
  });

  it('turns the action into a driver change once the return is approved', () => {
    renderWithProviders(
      block(
        'RETURN_APPROVED',
        info({
          approvedAt: '2026-10-26T11:00:00.000Z',
          returnDriver: { id: 'driver-1', fullName: 'Driver One', phone: '0599000001' },
        }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Change return driver' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve return' })).toBeNull();
  });

  it('shows the policy, the delivery part and the total return charge', () => {
    renderWithProviders(
      block(
        'RETURN_REQUESTED',
        info({ feePolicy: 'DELIVERY_PLUS_RETURN', deliveryCharge: '15.00', totalCharge: '25.00' }),
      ),
    );
    expect(screen.getByText('Delivery fee + return fee')).toBeTruthy();
    expect(screen.getByText('Delivery / attempt charge')).toBeTruthy();
    expect(screen.getByText('Total return charge')).toBeTruthy();
    expect(screen.getByText(/25\.00/)).toBeTruthy();
  });

  it('renders in Arabic', () => {
    renderWithProviders(block('RETURN_APPROVED', info()), 'ar');
    expect(screen.getByRole('button', { name: 'تغيير سائق الإرجاع' })).toBeTruthy();
    expect(screen.getByText('رسوم الإرجاع فقط')).toBeTruthy();
  });
});
