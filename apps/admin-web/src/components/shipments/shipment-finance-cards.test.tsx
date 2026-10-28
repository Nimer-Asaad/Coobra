// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FeeOverrideItem, ShipmentDetails } from '@coobra/shared';
import { renderWithProviders } from '@/test/render';
import { CodCard } from './shipment-finance-cards';

const override = (status: FeeOverrideItem['status']): FeeOverrideItem => ({
  id: 'override-1',
  phase: 'POST_DELIVERY',
  status,
  previousFee: '15.00',
  newFee: '16.00',
  reason: 'Wrong zone',
  actor: { id: 'acc-1', fullName: 'Accountant', role: 'ACCOUNTANT' },
  approvedBy: null,
  createdAt: '2026-10-26T10:00:00.000Z',
});

/** Only the fields CodCard reads. */
const shipment = (overrides: FeeOverrideItem[]) =>
  ({
    id: 'shipment-1',
    status: 'DELIVERED',
    deliveryFee: '15.00',
    codInfo: {
      status: 'COLLECTED',
      expected: '100.00',
      collected: '100.00',
      outstanding: '0.00',
      collections: [],
      shortfall: null,
    },
    pricing: { overrides },
  }) as unknown as ShipmentDetails;

describe('CodCard fee correction', () => {
  it('offers a correction when none is pending', () => {
    renderWithProviders(<CodCard shipment={shipment([])} canCorrectFee queryKey={['s']} />);
    expect(screen.getByRole('button', { name: 'Correct the delivery fee' })).toBeTruthy();
  });

  it('shows the pending correction and hides the form until it is decided', () => {
    renderWithProviders(
      <CodCard
        shipment={shipment([override('PENDING_APPROVAL')])}
        canCorrectFee
        queryKey={['s']}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Fee correction waiting for approval');
    expect(status.textContent).toContain('15.00');
    expect(status.textContent).toContain('16.00');
    expect(screen.queryByRole('button', { name: 'Correct the delivery fee' })).toBeNull();
  });

  it('allows a new correction after the previous one was rejected', () => {
    renderWithProviders(
      <CodCard shipment={shipment([override('REJECTED')])} canCorrectFee queryKey={['s']} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Correct the delivery fee' })).toBeTruthy();
  });
});
