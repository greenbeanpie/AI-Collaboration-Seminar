import { render,screen } from '@testing-library/react';
import { describe,it,expect } from 'vitest';
import { ProfileMarkdown } from './ProfileMarkdown';
describe('safe profile Markdown',()=>{
 it('renders formatting and HTTPS links without allowing HTML or tracking images',()=>{const {container}=render(<ProfileMarkdown value={'# About\n**Strong** and `code`\n[Safe](https://example.com)\n![track](https://evil.example/pixel)\n<img src=x onerror=alert(1)><script>alert(1)</script>\n[Bad](javascript:alert)\n[Data](data:text/html,evil)\n[Credential](https://user:pass@example.com)'} />);expect(screen.getByRole('heading',{name:'About'})).toBeTruthy();expect(container.querySelector('strong')?.textContent).toBe('Strong');expect(container.querySelectorAll('a')).toHaveLength(1);expect(container.querySelector('a')?.getAttribute('rel')).toContain('noreferrer');expect(container.querySelector('img,script,iframe,object')).toBeNull();});
});
