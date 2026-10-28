import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ShipmentListItem } from '@coobra/shared';
import { renderMobile } from '../test/render';
import { ChipBar, ChoiceField, ShipmentCard } from './components';

const options = [
  { value: 'HEBRON', label: 'Hebron' },
  { value: 'NABLUS', label: 'Nablus' },
];

describe('shared shipment controls (accessible names)', () => {
  it('names each filter chip and marks the selected one', () => {
    renderMobile(<ChipBar options={options} value="NABLUS" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Hebron' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nablus' })).toBeTruthy();
  });

  it('names the picker and every option, and reports the choice', () => {
    const onChange = vi.fn();
    renderMobile(
      <ChoiceField
        label="Delivery area"
        placeholder="Choose an area"
        options={options}
        value=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delivery area' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hebron' }));
    expect(onChange).toHaveBeenCalledWith('HEBRON');
  });

  it('names a shipment card by tracking number, recipient and status', () => {
    const shipment = {
      id: 's-1',
      trackingNumber: 'CB-12345678',
      status: 'DELIVERED',
      recipientName: 'Sara',
      governorate: 'NABLUS',
      city: 'Nablus',
      destination: null,
      codAmount: '40.00',
      createdAt: '2026-10-26T10:00:00.000Z',
    } as unknown as ShipmentListItem;
    renderMobile(<ShipmentCard shipment={shipment} onPress={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'CB-12345678 · Sara · Delivered' })).toBeTruthy();
  });
});
