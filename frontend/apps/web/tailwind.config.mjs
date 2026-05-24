/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'system-ui', 'sans-serif'],
      },
      transitionProperty: {
        radius: 'border-radius',
      },
      fontSize: {
        xxs: '0.625rem',
        tiny: '0.5rem',
      },

      typography: () => ({
        DEFAULT: {
          css: {
            p: {
              '@apply text-base': {},
            },
            li: {
              '@apply text-base': {},
            },
            hr: {
              '@apply mt-6 mb-6 max-w-[95%] mx-auto': {},
            },
            'h1, h2, h3, h4, h5, h6': {
              '@apply mt-0': {},
            },
          },
        },
      }),
    },
  },
};
