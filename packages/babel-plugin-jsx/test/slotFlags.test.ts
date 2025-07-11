import { transpile } from './util';

// stable slots
test.for([
  {
    name: 'basic',
    source: `<A>
      {{ default: () => {} }}
    </A>`,
  },
  {
    name: 'nested slots',
    source: `<A>
      {{ foo: ({ bar }) => (
        <B>
          {{ foo: () => {
            return <>{ bar }</>
          }}}
        </B>
      )}}
    </A>`,
  },
])('stable slots $name', async ({ source }) => {
  expect(await transpile(source, { optimize: true })).toMatchSnapshot();
});

// dynamic slots
test.for([
  {
    name: 'computed key',
    source: `<A>
      {{
        [name]: () => {},
      }}
    </A>`,
  },
  {
    name: 'conditional value',
    source: `<A>
      {{
        default: foo ? () => {} : undefined,
      }}
    </A>`,
  },
  {
    name: 'spread and computed key',
    source: `<A>
      {{ 
        ...slots,
        [name]: () => {},
      }}
    </A>`,
  },
  {
    name: 'spread and conditional value',
    source: `<A>
      {{ 
        ...slots,
        default: foo ? () => {} : undefined,
      }}
    </A>`,
  },
])('dynamic slots $name', async ({ source }) => {
  expect(await transpile(source, { optimize: true })).toMatchSnapshot();
});

// forwarded slots
test.for([
  {
    name: 'simple forward',
    source: `<A>
      {{ foo: slots.foo }}
    </A>`,
  },
  {
    skip: true, // TODO: need to analyze the function for usages
    name: 'used in slot function',
    source: `<A>
      {{ foo: () => slots.foo?.() }}
    </A>`,
  },
  {
    skip: true, // TODO: need to analyze the function for usages
    name: 'deep used in slot function',
    source: `<A>
      {{ foo: () => (
        <>
          { slots.foo() }
        </>
      )}}
    </A>`,
  },
  {
    name: 'spread all',
    source: `<A>
      {{ ...slots }}
    </A>`,
  },
  {
    name: 'v-slots passthrough',
    source: `<A v-slots={ slots } />`,
  },
  {
    name: 'spread and add stable',
    source: `<A>
      {{ 
        ...slots,
        foo: () => {},
      }}
    </A>`,
  },
  {
    name: 'conditional on slot existence',
    source: `<A>
      {{ default: slots.default ? slots.default() : undefined }}
    </A>`,
  },
  {
    name: 'spread and conditional',
    source: `<A>
      {{ 
        ...slots,
        default: slots.default ? slots.default() : undefined
      }}
    </A>`,
  },
])('forwarded slots $name', async ({ source, skip }, ctx) => {
  if (skip) ctx.skip();
  expect(await transpile(source, { optimize: true })).toMatchSnapshot();
});
