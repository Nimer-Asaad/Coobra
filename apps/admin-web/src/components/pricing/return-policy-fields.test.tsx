// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ReturnPolicyFields } from './pricing-panel';

describe('ReturnPolicyFields', () => {
  it('defaults to return fee only and asks for an attempt fee only for that policy', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnPolicyFields idPrefix="t" errors={{}} />);
    const select = screen.getByLabelText('Return charge policy') as HTMLSelectElement;
    expect(select.value).toBe('RETURN_ONLY');
    expect(screen.queryByLabelText('Failed-attempt fee (₪)')).toBeNull();
    await user.selectOptions(select, 'REDUCED_ATTEMPT_PLUS_RETURN');
    expect(screen.getByLabelText('Failed-attempt fee (₪)')).toBeTruthy();
    await user.selectOptions(select, 'DELIVERY_PLUS_RETURN');
    expect(screen.queryByLabelText('Failed-attempt fee (₪)')).toBeNull();
  });

  it('shows translated validation errors', () => {
    renderWithProviders(
      <ReturnPolicyFields
        idPrefix="t"
        defaultPolicy="REDUCED_ATTEMPT_PLUS_RETURN"
        defaultAttemptFee="30.00"
        errors={{ attemptFee: 'validation.pricing.attemptFeeTooHigh' }}
      />,
      'ar',
    );
    expect(screen.getByText('لا يمكن أن تزيد رسوم المحاولة الفاشلة عن رسوم التوصيل.')).toBeTruthy();
    expect((screen.getByLabelText('رسوم المحاولة الفاشلة (₪)') as HTMLInputElement).value).toBe(
      '30.00',
    );
  });
});
