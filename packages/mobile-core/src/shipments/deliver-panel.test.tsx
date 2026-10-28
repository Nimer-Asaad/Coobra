import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ShipmentDetails } from '@coobra/shared';
import { ApiError } from '../api-client';
import { renderMobile } from '../test/render';
import { DeliverPanel } from './details-screen';

const shipment = { id: 's-1', codAmount: '40.00' } as ShipmentDetails;
const PARTIAL_HINT = 'Please write a reason (at least 3 characters).';
const COD_ERROR = 'The collected amount does not match the cash on delivery.';

/** The transition's error lives in the parent and is reset on any edit, as in the screen. */
function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [error, setError] = useState<unknown>(
    new ApiError({ statusCode: 422, code: 'SHIPMENT_COD_MISMATCH', message: 'x' }),
  );
  return (
    <DeliverPanel
      shipment={shipment}
      loading={false}
      error={error}
      onEdit={() => setError(null)}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />
  );
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => screen.getByRole('button', { name: 'Confirm delivery' });

describe('DeliverPanel', () => {
  it('names its radios and checkbox and reports their state', () => {
    renderMobile(<Harness onSubmit={vi.fn()} />);
    const yes = screen.getByRole('radio', { name: 'Yes, collected' });
    expect(yes.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(yes);
    expect(screen.getByRole('radio', { name: 'Yes, collected' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      screen.getByRole('checkbox', { name: 'I confirm I handed the shipment to the recipient.' }),
    ).toBeTruthy();
  });

  it('clears the previous attempt’s error as soon as an answer changes', () => {
    renderMobile(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByText(COD_ERROR)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Yes, collected' }));
    expect(screen.queryByText(COD_ERROR)).toBeNull();
  });

  it('explains why a partial collection cannot be submitted yet, instead of failing silently', () => {
    const onSubmit = vi.fn();
    renderMobile(<Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes, collected' }));
    type('Amount collected (₪)', '20');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(PARTIAL_HINT)).toBeTruthy();
    expect(submit().getAttribute('aria-disabled')).toBe('true');

    type('Why was less collected?', 'Recipient paid half');
    expect(screen.queryByText(PARTIAL_HINT)).toBeNull();
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith({
      collected: true,
      amount: '20',
      confirmed: true,
      partialReason: 'Recipient paid half',
    });
  });

  it('needs no reason for the full amount', () => {
    const onSubmit = vi.fn();
    renderMobile(<Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes, collected' }));
    type('Amount collected (₪)', '40');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText(PARTIAL_HINT)).toBeNull();
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith({ collected: true, amount: '40', confirmed: true });
  });
});
