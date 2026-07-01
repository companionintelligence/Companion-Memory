import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolBlock } from './ToolBlock';

describe('ToolBlock', () => {
  it('announces the tool being called', () => {
    render(<ToolBlock toolName="search_web" />);

    expect(screen.getByText('Calling search_web...')).toBeInTheDocument();
  });
});
