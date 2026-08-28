import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { InlineModal } from './InlineModal';

describe('InlineModal', () => {
  afterEach(() => {
    document.getElementById('content-modal')?.remove();
  });

  it('portals into the named layout slot so it is not stuck at the scroll origin', () => {
    const host = document.createElement('div');
    host.id = 'content-modal';
    document.body.append(host);

    render(
      <div data-testid="page">
        <InlineModal open portalId="content-modal" autoFocus aria-label="Action chat">
          body
        </InlineModal>
      </div>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Action chat' });

    expect(host).toContainElement(dialog);
    expect(screen.getByTestId('page')).not.toContainElement(dialog);
    expect(dialog).toHaveFocus();
  });
});
