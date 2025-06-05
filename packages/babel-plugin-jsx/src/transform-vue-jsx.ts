import * as t from '@babel/types';
import { type NodePath, type Visitor } from '@babel/traverse';
import { addDefault } from '@babel/helper-module-imports';
import {
  buildIIFE,
  checkIsComponent,
  createIdentifier,
  dedupeProperties,
  getJSXAttributeName,
  getTag,
  isConstant,
  isDirective,
  isOn,
  transformJSXExpressionContainer,
  transformJSXSpreadAttribute,
  transformJSXSpreadChild,
  transformJSXText,
  transformText,
  walksScope,
} from './utils';
import SlotFlags, { determineSlotFlags } from './slotFlags';
import { PatchFlags } from './patchFlags';
import parseDirectives from './parseDirectives';
import type { Slots, State } from './interface';

const xlinkRE = /^xlink([A-Z])/;

const getJSXAttributeValue = (
  path: NodePath<t.JSXAttribute>,
  state: State
): t.StringLiteral | t.Expression | null => {
  const valuePath = path.get('value');
  if (valuePath.isJSXElement()) {
    return transformJSXElement(valuePath, state);
  }
  if (valuePath.isStringLiteral()) {
    return t.stringLiteral(transformText(valuePath.node.value));
  }
  if (valuePath.isJSXExpressionContainer()) {
    return transformJSXExpressionContainer(valuePath);
  }

  return null;
};

const buildProps = (path: NodePath<t.JSXElement>, state: State) => {
  const tag = getTag(path, state);
  const isComponent = checkIsComponent(path.get('openingElement'), state);
  const props = path.get('openingElement').get('attributes');
  const directives: t.ArrayExpression[] = [];
  const dynamicPropNames = new Set<string>();

  let slots = null as Slots;
  let patchFlag = 0;

  if (props.length === 0) {
    return {
      tag,
      isComponent,
      slots,
      props: t.nullLiteral(),
      directives,
      patchFlag,
      dynamicPropNames,
    };
  }

  let properties: t.ObjectProperty[] = [];

  // patchFlag analysis
  let hasRef = false;
  let hasClassBinding = false;
  let hasStyleBinding = false;
  let hasHydrationEventBinding = false;
  let hasDynamicKeys = false;

  const mergeArgs: (t.CallExpression | t.ObjectExpression | t.Identifier)[] =
    [];
  const { mergeProps = true } = state.opts;
  props.forEach((prop) => {
    if (prop.isJSXAttribute()) {
      let name = getJSXAttributeName(prop);

      const attributeValue = getJSXAttributeValue(prop, state);

      if (!isConstant(attributeValue) || name === 'ref') {
        if (
          !isComponent &&
          isOn(name) &&
          // omit the flag for click handlers becaues hydration gives click
          // dedicated fast path.
          name.toLowerCase() !== 'onclick' &&
          // omit v-model handlers
          name !== 'onUpdate:modelValue'
        ) {
          hasHydrationEventBinding = true;
        }

        if (name === 'ref') {
          hasRef = true;
        } else if (name === 'class' && !isComponent) {
          hasClassBinding = true;
        } else if (name === 'style' && !isComponent) {
          hasStyleBinding = true;
        } else if (name !== 'key' && !isDirective(name) && name !== 'on') {
          dynamicPropNames.add(name);
        }
      }
      if (state.opts.transformOn && (name === 'on' || name === 'nativeOn')) {
        if (!state.get('transformOn')) {
          state.set(
            'transformOn',
            addDefault(path, '@vuetify/babel-helper-vue-transform-on', {
              nameHint: '_transformOn',
            })
          );
        }
        mergeArgs.push(
          t.callExpression(state.get('transformOn'), [
            attributeValue || t.booleanLiteral(true),
          ])
        );
        return;
      }
      if (isDirective(name)) {
        const { directive, modifiers, values, args, directiveName } =
          parseDirectives({
            tag,
            isComponent,
            name,
            path: prop,
            state,
            value: attributeValue,
          });

        if (directiveName === 'slots') {
          slots = attributeValue as Slots;
          return;
        }
        if (directive) {
          directives.push(t.arrayExpression(directive));
        } else if (directiveName === 'html') {
          properties.push(
            t.objectProperty(t.stringLiteral('innerHTML'), values[0] as any)
          );
          dynamicPropNames.add('innerHTML');
        } else if (directiveName === 'text') {
          properties.push(
            t.objectProperty(t.stringLiteral('textContent'), values[0] as any)
          );
          dynamicPropNames.add('textContent');
        }

        if (['models', 'model'].includes(directiveName)) {
          values.forEach((value, index) => {
            const propName = args[index];
            // v-model target with variable
            const isDynamic =
              propName &&
              !t.isStringLiteral(propName) &&
              !t.isNullLiteral(propName);

            // must be v-model or v-models and is a component
            if (!directive) {
              properties.push(
                t.objectProperty(
                  t.isNullLiteral(propName)
                    ? t.stringLiteral('modelValue')
                    : propName,
                  value as any,
                  isDynamic
                )
              );
              if (!isDynamic) {
                dynamicPropNames.add(
                  (propName as t.StringLiteral)?.value || 'modelValue'
                );
              }

              if (modifiers[index]?.size) {
                properties.push(
                  t.objectProperty(
                    isDynamic
                      ? t.binaryExpression(
                          '+',
                          propName,
                          t.stringLiteral('Modifiers')
                        )
                      : t.stringLiteral(
                          `${
                            (propName as t.StringLiteral)?.value || 'model'
                          }Modifiers`
                        ),
                    t.objectExpression(
                      [...modifiers[index]].map((modifier) =>
                        t.objectProperty(
                          t.stringLiteral(modifier),
                          t.booleanLiteral(true)
                        )
                      )
                    ),
                    isDynamic
                  )
                );
              }
            }

            const updateName = isDynamic
              ? t.binaryExpression('+', t.stringLiteral('onUpdate:'), propName)
              : t.stringLiteral(
                  `onUpdate:${
                    (propName as t.StringLiteral)?.value || 'modelValue'
                  }`
                );

            properties.push(
              t.objectProperty(
                updateName,
                t.arrowFunctionExpression(
                  [t.identifier('$event')],
                  t.assignmentExpression(
                    '=',
                    value as any,
                    t.identifier('$event')
                  )
                ),
                isDynamic
              )
            );

            if (!isDynamic) {
              dynamicPropNames.add((updateName as t.StringLiteral).value);
            } else {
              hasDynamicKeys = true;
            }
          });
        }
      } else {
        if (name.match(xlinkRE)) {
          name = name.replace(
            xlinkRE,
            (_, firstCharacter) => `xlink:${firstCharacter.toLowerCase()}`
          );
        }
        properties.push(
          t.objectProperty(
            t.stringLiteral(name),
            attributeValue || t.booleanLiteral(true)
          )
        );
      }
    } else {
      if (properties.length && mergeProps) {
        mergeArgs.push(
          t.objectExpression(dedupeProperties(properties, mergeProps))
        );
        properties = [];
      }

      // JSXSpreadAttribute
      hasDynamicKeys = true;
      transformJSXSpreadAttribute(
        path as NodePath,
        prop as NodePath<t.JSXSpreadAttribute>,
        mergeProps,
        mergeProps ? mergeArgs : properties
      );
    }
  });

  // patchFlag analysis
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS;
  } else {
    if (hasClassBinding) {
      patchFlag |= PatchFlags.CLASS;
    }
    if (hasStyleBinding) {
      patchFlag |= PatchFlags.STYLE;
    }
    if (dynamicPropNames.size) {
      patchFlag |= PatchFlags.PROPS;
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS;
    }
  }

  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || directives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH;
  }

  let propsExpression: t.Expression | t.ObjectProperty | t.Literal =
    t.nullLiteral();
  if (mergeArgs.length) {
    if (properties.length) {
      mergeArgs.push(
        t.objectExpression(dedupeProperties(properties, mergeProps))
      );
    }
    if (mergeArgs.length > 1) {
      propsExpression = t.callExpression(
        createIdentifier(state, 'mergeProps'),
        mergeArgs
      );
    } else {
      // single no need for a mergeProps call
      if (isComponent) {
        // createVNode already normalizes props
        propsExpression = mergeArgs[0];
      } else {
        propsExpression = t.callExpression(
          createIdentifier(state, 'normalizeProps'),
          [
            t.callExpression(createIdentifier(state, 'guardReactiveProps'), [
              mergeArgs[0],
            ]),
          ]
        );
      }
    }
  } else if (properties.length) {
    // single no need for spread
    if (properties.length === 1 && t.isSpreadElement(properties[0])) {
      propsExpression = (properties[0] as unknown as t.SpreadElement).argument;
    } else {
      propsExpression = t.objectExpression(
        dedupeProperties(properties, mergeProps)
      );
      for (let i = 0; i < propsExpression.properties.length; i++) {
        const property = propsExpression.properties[i];
        if (
          !t.isObjectProperty(property) ||
          !t.isStringLiteral(property.key) ||
          !t.isExpression(property.value)
        ) {
          continue;
        }
        // TODO: if isConstant, pre-normalize class and style during build
        if (property.key.value === 'class') {
          if (!t.isStringLiteral(property.value)) {
            property.value = t.callExpression(
              createIdentifier(state, 'normalizeClass'),
              [property.value]
            );
          }
        } else if (property.key.value === 'style') {
          if (
            !t.isStringLiteral(property.value) &&
            !t.isObjectExpression(property.value)
          ) {
            property.value = t.callExpression(
              createIdentifier(state, 'normalizeStyle'),
              [property.value]
            );
          }
        }
      }
    }
  }

  return {
    tag,
    props: propsExpression,
    isComponent,
    slots,
    directives,
    patchFlag,
    dynamicPropNames,
  };
};

/**
 * Get children from Array of JSX children
 * @param paths Array<JSXText | JSXExpressionContainer  | JSXElement | JSXFragment>
 * @returns Array<Expression | SpreadElement>
 */
const getChildren = (
  paths: NodePath<
    | t.JSXText
    | t.JSXExpressionContainer
    | t.JSXSpreadChild
    | t.JSXElement
    | t.JSXFragment
  >[],
  state: State
): t.Expression[] =>
  paths
    .map((path) => {
      if (path.isJSXText()) {
        const transformedText = transformJSXText(path);
        if (transformedText) {
          return t.callExpression(createIdentifier(state, 'createTextVNode'), [
            transformedText,
          ]);
        }
        return transformedText;
      }
      if (path.isJSXExpressionContainer()) {
        const expression = transformJSXExpressionContainer(path);

        if (t.isIdentifier(expression)) {
          const { name } = expression;
          const { referencePaths = [] } = path.scope.getBinding(name) || {};
          referencePaths.forEach((referencePath) => {
            walksScope(referencePath, name, SlotFlags.DYNAMIC);
          });
        }

        return expression;
      }
      if (path.isJSXSpreadChild()) {
        return transformJSXSpreadChild(path);
      }
      if (path.isCallExpression()) {
        return (path as NodePath<t.CallExpression>).node;
      }
      if (path.isJSXElement()) {
        return transformJSXElement(path, state);
      }
      throw new Error(`getChildren: ${path.type} is not supported`);
    })
    .filter(
      ((value: any) => value != null && !t.isJSXEmptyExpression(value)) as any
    );

const transformJSXElement = (
  path: NodePath<t.JSXElement>,
  state: State
): t.CallExpression => {
  const children = getChildren(path.get('children'), state);
  let {
    tag,
    props,
    isComponent,
    directives,
    patchFlag,
    dynamicPropNames,
    slots,
  } = buildProps(path, state);

  const { optimize = false } = state.opts;

  // #541 - directives can't be resolved in optimized slots
  // all parents should be deoptimized
  if (
    directives.length &&
    directives.some(
      (d) =>
        d.elements?.[0]?.type === 'CallExpression' &&
        d.elements[0].callee.type === 'Identifier' &&
        d.elements[0].callee.name === '_resolveDirective'
    )
  ) {
    let currentPath = path;
    while (currentPath.parentPath?.isJSXElement()) {
      currentPath = currentPath.parentPath;
      currentPath.setData('slotFlag', SlotFlags.DYNAMIC);
    }
  }

  let slotFlag = path.getData('slotFlag') ?? SlotFlags.STABLE;
  let VNodeChild;

  if (children.length > 1 || slots) {
    /*
      <A v-slots={slots}>{a}{b}</A>
        ---> {{ default: () => [a, b], ...slots }}
        ---> {[a, b]}
    */
    if (!isComponent) {
      VNodeChild = t.arrayExpression(children);
    } else if (!children.length && !optimize) {
      VNodeChild = slots;
    } else {
      VNodeChild = t.objectExpression([]);
      if (children.length) {
        VNodeChild.properties.push(
          t.objectProperty(
            t.identifier('default'),
            t.arrowFunctionExpression(
              [],
              t.arrayExpression(buildIIFE(path, children))
            )
          )
        );
      }
      if (slots) {
        if (t.isObjectExpression(slots)) {
          slotFlag = determineSlotFlags(slots, slotFlag);
          VNodeChild.properties.push(...slots.properties);
        } else {
          slotFlag =
            slotFlag === SlotFlags.DYNAMIC
              ? slotFlag
              : slots.name === 'slots'
                ? SlotFlags.FORWARDED
                : SlotFlags.DYNAMIC;
          VNodeChild.properties.push(t.spreadElement(slots));
        }
      }
      if (optimize) {
        VNodeChild.properties.push(
          t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag))
        );
      }
    }
  } else if (children.length === 1) {
    /*
      <A>{a}</A> or <A>{() => a}</A>
     */
    const { enableObjectSlots = true } = state.opts;
    const child = children[0];
    const objectExpression = t.objectExpression(
      [
        t.objectProperty(
          t.identifier('default'),
          t.arrowFunctionExpression(
            [],
            t.arrayExpression(buildIIFE(path, [child]))
          )
        ),
        optimize &&
          t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag)),
      ].filter((v) => !!v)
    );
    if (t.isIdentifier(child) && isComponent) {
      if (enableObjectSlots) {
        VNodeChild = t.conditionalExpression(
          t.callExpression(state.get('@vue/babel-plugin-jsx/runtimeIsSlot')(), [
            child,
          ]),
          child,
          objectExpression
        );
      } else {
        VNodeChild = objectExpression;
      }
    } else if (t.isCallExpression(child) && child.loc && isComponent) {
      // the element was generated and doesn't have location information
      if (enableObjectSlots) {
        const { scope } = path;
        const slotId = scope.generateUidIdentifier('slot');
        if (scope) {
          scope.push({
            id: slotId,
            kind: 'let',
          });
        }
        const alternate = t.objectExpression(
          [
            t.objectProperty(
              t.identifier('default'),
              t.arrowFunctionExpression(
                [],
                t.arrayExpression(buildIIFE(path, [slotId]))
              )
            ),
            optimize &&
              t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag)),
          ].filter((v) => !!v)
        );
        const assignment = t.assignmentExpression('=', slotId, child);
        const condition = t.callExpression(
          state.get('@vue/babel-plugin-jsx/runtimeIsSlot')(),
          [assignment]
        );
        VNodeChild = t.conditionalExpression(condition, slotId, alternate);
      } else {
        VNodeChild = objectExpression;
      }
    } else if (
      t.isFunctionExpression(child) ||
      t.isArrowFunctionExpression(child)
    ) {
      VNodeChild = t.objectExpression(
        [
          t.objectProperty(t.identifier('default'), child),
          optimize &&
            t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag)),
        ].filter((v) => !!v)
      );
    } else if (t.isObjectExpression(child)) {
      slotFlag = determineSlotFlags(child, slotFlag);
      VNodeChild = t.objectExpression(
        [
          ...child.properties,
          optimize &&
            t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag)),
        ].filter((v) => !!v)
      );
    } else {
      VNodeChild = t.arrayExpression([child]);
      if (isComponent) {
        VNodeChild = t.objectExpression(
          [
            t.objectProperty(
              t.identifier('default'),
              t.arrowFunctionExpression([], VNodeChild)
            ),
            optimize &&
              t.objectProperty(t.identifier('_'), t.numericLiteral(slotFlag)),
          ].filter((v) => !!v)
        );
      }
    }
  }

  if (slotFlag === SlotFlags.DYNAMIC) {
    patchFlag |= PatchFlags.DYNAMIC_SLOTS;
  }

  const createVNode = t.callExpression(
    createIdentifier(state, isComponent ? 'createVNode' : 'createElementVNode'),
    [
      tag,
      props,
      VNodeChild || t.nullLiteral(),
      !!patchFlag && optimize && t.numericLiteral(patchFlag),
      !!dynamicPropNames.size &&
        optimize &&
        t.arrayExpression(
          [...dynamicPropNames.keys()].map((name) => t.stringLiteral(name))
        ),
    ].filter((v) => !!v)
  );

  if (!directives.length) {
    return createVNode;
  }

  return t.callExpression(createIdentifier(state, 'withDirectives'), [
    createVNode,
    t.arrayExpression(directives),
  ]);
};

const visitor: Visitor<State> = {
  JSXElement: {
    exit(path, state) {
      path.replaceWith(transformJSXElement(path, state));
    },
  },
};

export default visitor;
