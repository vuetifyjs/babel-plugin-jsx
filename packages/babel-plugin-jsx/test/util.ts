import { transform } from '@babel/core';
import JSX, { type VueJSXPluginOptions } from '../src';

export function transpile(source: string, options: VueJSXPluginOptions = {}) {
  return new Promise((resolve, reject) =>
    transform(
      source,
      {
        filename: '',
        presets: null,
        plugins: [[JSX, options]],
        configFile: false,
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result?.code);
      }
    )
  );
}
