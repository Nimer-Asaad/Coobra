import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderMobile } from '../test/render';
import { AppButton } from './button';

describe('AppButton', () => {
  it('is a button named by its title', () => {
    const onPress = vi.fn();
    renderMobile(<AppButton title="Request a payout" onPress={onPress} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request a payout' }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps its name while loading (only a spinner is visible) and is disabled', () => {
    const onPress = vi.fn();
    renderMobile(<AppButton title="Request a payout" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Request a payout' });
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
