import tailwindcss from '@tailwindcss/postcss';
import nesting from 'postcss-nesting';
import autoprefixer from 'autoprefixer';

// Tailwind v4 emits Media Queries Level 4 range syntax, e.g.
//   @media (width >= 48rem)
// Older Android System WebViews (Chrome < 104) cannot parse range syntax and
// silently drop every responsive rule, so those devices render the mobile
// layout at any size. This plugin rewrites the queries back to the classic
// min-width/max-width form, which every browser understands.
const mqRangeCompat = {
  postcssPlugin: 'mq-range-compat',
  AtRule(rule) {
    if (rule.name !== 'media' || !rule.params) return;
    if (/width\s*>=/.test(rule.params)) {
      rule.params = rule.params.replace(
        /\(\s*width\s*>=\s*([^)]+?)\s*\)/g,
        '(min-width: $1)',
      );
    }
    if (/width\s*<=/.test(rule.params)) {
      rule.params = rule.params.replace(
        /\(\s*width\s*<=\s*([^)]+?)\s*\)/g,
        '(max-width: $1)',
      );
    }
    if (/width\s*</.test(rule.params)) {
      rule.params = rule.params.replace(
        /\(\s*width\s*<\s*([^)]+?)\s*\)/g,
        '(max-width: calc($1 - 0.02px))',
      );
    }
    if (/width\s*>/.test(rule.params)) {
      rule.params = rule.params.replace(
        /\(\s*width\s*>\s*([^)]+?)\s*\)/g,
        '(min-width: calc($1 + 0.02px))',
      );
    }
  },
};

export default {
  plugins: [tailwindcss(), mqRangeCompat, nesting(), autoprefixer()],
}
