import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const packagesRoot = path.join(repoRoot, 'packages');
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ignoredDirectories = new Set(['node_modules', 'dist', '.next', 'coverage']);
const durableMockMethods = new Set([
  'mockImplementation',
  'mockReturnValue',
  'mockResolvedValue',
  'mockRejectedValue',
]);
const persistentMockMethods = new Set([
  ...durableMockMethods,
  'mockImplementationOnce',
  'mockReturnValueOnce',
  'mockResolvedValueOnce',
  'mockRejectedValueOnce',
]);
const resetMockMethods = new Set(['mockReset', 'mockRestore']);

function collectTestFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectTestFiles(path.join(directory, entry.name), files);
      }
      continue;
    }
    if (testFilePattern.test(entry.name)) files.push(path.join(directory, entry.name));
  }
  return files;
}

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callbackFromCall(node, resolveIdentifier) {
  if (!ts.isCallExpression(node)) return null;
  for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
    const candidate = node.arguments[index];
    if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return candidate;
    if (ts.isIdentifier(candidate)) {
      const resolved = resolveIdentifier(candidate);
      if (resolved) return resolved;
    }
  }
  return null;
}

function callRootName(expression) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return callRootName(node.expression);
  }
  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'vi'
      && node.expression.name.text === 'mocked'
      && node.arguments[0]
    ) {
      return callRootName(node.arguments[0]);
    }
    return callRootName(node.expression);
  }
  return null;
}

function directCallName(expression) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression
    && (
      ts.isStringLiteral(node.argumentExpression)
      || ts.isNumericLiteral(node.argumentExpression)
    )
  ) return node.argumentExpression.text;
  if (ts.isCallExpression(node)) return directCallName(node.expression);
  return null;
}

function memberName(expression) {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression
    && (
      ts.isStringLiteral(node.argumentExpression)
      || ts.isNumericLiteral(node.argumentExpression)
    )
  ) return node.argumentExpression.text;
  return null;
}

function isNamedCall(node, names) {
  return ts.isCallExpression(node) && names.has(directCallName(node.expression));
}

function receiverKey(call, sourceFile) {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const receiver = unwrap(call.expression.expression);
  if (
    ts.isCallExpression(receiver)
    && ts.isPropertyAccessExpression(receiver.expression)
    && ts.isIdentifier(receiver.expression.expression)
    && receiver.expression.expression.text === 'vi'
    && receiver.expression.name.text === 'mocked'
    && receiver.arguments[0]
  ) {
    return unwrap(receiver.arguments[0]).getText(sourceFile).replace(/\s+/g, '');
  }
  return receiver.getText(sourceFile).replace(/\s+/g, '');
}

function spyTarget(receiver, sourceFile) {
  const node = unwrap(receiver);
  if (
    !ts.isCallExpression(node)
    || !ts.isPropertyAccessExpression(node.expression)
    || !ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'vi'
    || node.expression.name.text !== 'spyOn'
    || !node.arguments[0]
  ) return null;

  const target = unwrap(node.arguments[0]);
  const root = callRootName(target);
  if (!root) return null;
  const targetText = target.getText(sourceFile).replace(/\s+/g, '');
  const property = node.arguments[1];
  const key = property && (ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property))
    ? `${targetText}.${property.text}`
    : `${targetText}[${property?.getText(sourceFile).replace(/\s+/g, '') ?? '?'}]`;
  const propertySuffix = property
    ? (
      ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property)
        ? `.${property.text}`
        : `[${property.getText(sourceFile).replace(/\s+/g, '')}]`
    )
    : '[?]';
  return { key, root, target, propertySuffix };
}

function spyTargetFromInitializer(initializer, sourceFile) {
  const direct = spyTarget(initializer, sourceFile);
  if (direct) return direct;
  const node = unwrap(initializer);
  if (
    ts.isCallExpression(node)
    && (
      ts.isPropertyAccessExpression(node.expression)
      || ts.isElementAccessExpression(node.expression)
    )
    && persistentMockMethods.has(memberName(node.expression))
  ) return spyTarget(node.expression.expression, sourceFile);
  return null;
}

function nearestFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current)
      || ts.isFunctionExpression(current)
      || ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
    ) return current;
    current = current.parent;
  }
  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, names);
  }
}

function isFunctionNode(node) {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node);
}

function bindingContains(name, target) {
  const names = new Set();
  collectBindingNames(name, names);
  return names.has(target);
}

function functionHasVarBinding(node, target) {
  let found = false;
  function visit(current) {
    if (found || (current !== node && isFunctionNode(current))) return;
    if (
      ts.isVariableDeclaration(current)
      && ts.isVariableDeclarationList(current.parent)
      && !(current.parent.flags & ts.NodeFlags.BlockScoped)
      && bindingContains(current.name, target)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  if (node.body) visit(node.body);
  return found;
}

function blockHasLexicalBinding(block, target) {
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindingContains(declaration.name, target)) return true;
      }
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name?.text === target
    ) return true;
  }
  return false;
}

function isLocallyBoundAt(target, node, callback) {
  let current = node;
  while (current) {
    if (ts.isBlock(current) && blockHasLexicalBinding(current, target)) return true;
    if (isFunctionNode(current)) {
      if (current.parameters.some((parameter) => bindingContains(parameter.name, target))) {
        return true;
      }
      if (functionHasVarBinding(current, target)) return true;
      if (current === callback) return false;
    }
    if (
      ts.isCatchClause(current)
      && current.variableDeclaration
      && bindingContains(current.variableDeclaration.name, target)
    ) return true;
    if (
      (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current))
      && current.initializer
      && ts.isVariableDeclarationList(current.initializer)
      && current.initializer.declarations.some(
        (declaration) => bindingContains(declaration.name, target),
      )
    ) return true;
    current = current.parent;
  }
  return false;
}

function auditText(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const issues = [];
  const hookIssueKeys = new Set();
  const helperCapturedEnvironments = new WeakMap();
  const testCallbacks = [];
  const setupCallbacks = [];
  const teardownCallbacks = [];
  const suiteCallbacks = new Set();
  const suiteRegistrations = new Map();
  let allAssignmentExpressions = null;

  function executionContainer(node) {
    let current = node.parent;
    while (current) {
      if (isFunctionNode(current) || ts.isSourceFile(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  }

  function isAncestor(ancestor, node) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  function assignmentDominatesUse(assignment, use) {
    let block = use.parent;
    while (block) {
      if (ts.isBlock(block) || ts.isSourceFile(block)) {
        let assignmentStatement = assignment;
        while (assignmentStatement.parent && assignmentStatement.parent !== block) {
          assignmentStatement = assignmentStatement.parent;
        }
        let useStatement = use;
        while (useStatement.parent && useStatement.parent !== block) {
          useStatement = useStatement.parent;
        }
        if (
          assignmentStatement.parent === block
          && useStatement.parent === block
          && ts.isExpressionStatement(assignmentStatement)
        ) {
          let expressionNode = assignment;
          while (expressionNode.parent && expressionNode.parent !== assignmentStatement) {
            const parent = expressionNode.parent;
            if (
              ts.isConditionalExpression(parent)
              || (
                ts.isBinaryExpression(parent)
                && [
                  ts.SyntaxKind.AmpersandAmpersandToken,
                  ts.SyntaxKind.BarBarToken,
                  ts.SyntaxKind.QuestionQuestionToken,
                ].includes(parent.operatorToken.kind)
              )
              || (
                (
                  ts.isCallExpression(parent)
                  || ts.isPropertyAccessExpression(parent)
                  || ts.isElementAccessExpression(parent)
                )
                && parent.questionDotToken
              )
            ) return false;
            expressionNode = parent;
          }
          const assignmentIndex = block.statements.indexOf(assignmentStatement);
          const useIndex = block.statements.indexOf(useStatement);
          return assignmentIndex >= 0 && assignmentIndex < useIndex;
        }
      }
      block = block.parent;
    }
    return false;
  }

  function projectedBindingValue(name, target, value) {
    if (ts.isIdentifier(name)) return name.text === target ? value : null;
    if (ts.isObjectBindingPattern(name)) {
      const objectInfo = resolveObjectLiteralInfo(
        value.expression,
        new Set(),
        value.environment,
      );
      if (!objectInfo) return null;
      for (const element of name.elements) {
        if (!bindingContains(element.name, target) || element.dotDotDotToken) continue;
        const property = element.propertyName ?? element.name;
        const propertyName = resolvedPropertyName(property);
        if (propertyName === null) return null;
        let selected = objectPropertyValue(
          objectInfo.literal,
          propertyName,
          objectInfo.environment,
        );
        if (
          element.initializer
          && (
            !selected
            || ts.isOmittedExpression(unwrap(selected.expression))
            || isSemanticallyUndefined(selected.expression, selected.environment)
          )
        ) {
          selected = {
            expression: element.initializer,
            environment: value.environment,
          };
        }
        return selected
          ? projectedBindingValue(element.name, target, selected)
          : null;
      }
    }
    if (ts.isArrayBindingPattern(name)) {
      const arrayInfo = resolveArrayLiteralInfo(
        value.expression,
        new Set(),
        value.environment,
      );
      if (!arrayInfo) return null;
      for (let index = 0; index < name.elements.length; index += 1) {
        const element = name.elements[index];
        if (
          !ts.isBindingElement(element)
          || element.dotDotDotToken
          || !bindingContains(element.name, target)
        ) continue;
        let selected = arrayElementValue(
          arrayInfo.literal,
          index,
          arrayInfo.environment,
        );
        if (
          element.initializer
          && (
            !selected
            || ts.isOmittedExpression(unwrap(selected.expression))
            || isSemanticallyUndefined(selected.expression, selected.environment)
          )
        ) {
          selected = {
            expression: element.initializer,
            environment: value.environment,
          };
        }
        return selected
          ? projectedBindingValue(element.name, target, selected)
          : null;
      }
    }
    return null;
  }

  function bindingInitializerValue(declaration, target) {
    if (!declaration.initializer) return null;
    return projectedBindingValue(
      declaration.name,
      target,
      { expression: declaration.initializer, environment: new Map() },
    );
  }

  function assignmentTargetIdentifier(pattern, target) {
    const node = unwrap(pattern);
    if (ts.isIdentifier(node)) return node.text === target ? node : null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return assignmentTargetIdentifier(node.left, target);
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const found = assignmentTargetIdentifier(property.initializer, target);
          if (found) return found;
        } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === target) {
          return property.name;
        } else if (ts.isSpreadAssignment(property)) {
          const found = assignmentTargetIdentifier(property.expression, target);
          if (found) return found;
        }
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        const found = assignmentTargetIdentifier(
          ts.isSpreadElement(element) ? element.expression : element,
          target,
        );
        if (found) return found;
      }
    }
    return null;
  }

  function patternHasDefaultTarget(pattern, target) {
    const node = unwrap(pattern);
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && assignmentTargetIdentifier(node.left, target)
    ) return true;
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) => (
        ts.isPropertyAssignment(property)
          ? patternHasDefaultTarget(property.initializer, target)
          : ts.isShorthandPropertyAssignment(property)
            ? Boolean(
              property.objectAssignmentInitializer
              && property.name.text === target
            )
            : ts.isSpreadAssignment(property)
              ? patternHasDefaultTarget(property.expression, target)
              : false
      ));
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some((element) => patternHasDefaultTarget(
        ts.isSpreadElement(element) ? element.expression : element,
        target,
      ));
    }
    return false;
  }

  function bindingHasDefaultTarget(name, target) {
    if (ts.isIdentifier(name)) return false;
    return name.elements.some((element) => (
      ts.isBindingElement(element)
      && bindingContains(element.name, target)
      && (
        Boolean(element.initializer)
        || bindingHasDefaultTarget(element.name, target)
      )
    ));
  }

  function bindingSourcePropertyPath(name, target) {
    if (ts.isIdentifier(name)) return name.text === target ? [] : null;
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (!bindingContains(element.name, target)) continue;
        if (element.dotDotDotToken) {
          return bindingSourcePropertyPath(element.name, target);
        }
        const propertyName = resolvedPropertyName(element.propertyName ?? element.name);
        const nested = bindingSourcePropertyPath(element.name, target);
        return propertyName === null || nested === null
          ? null
          : [propertyName, ...nested];
      }
    }
    if (ts.isArrayBindingPattern(name)) {
      for (let index = 0; index < name.elements.length; index += 1) {
        const element = name.elements[index];
        if (
          ts.isBindingElement(element)
          && bindingContains(element.name, target)
        ) {
          const nested = bindingSourcePropertyPath(element.name, target);
          return nested === null
            ? null
            : element.dotDotDotToken
              ? [`@array-rest:${index}`, ...nested]
              : [String(index), ...nested];
        }
      }
    }
    return null;
  }

  function assignmentSourcePropertyPath(pattern, target) {
    const node = unwrap(pattern);
    if (ts.isIdentifier(node)) return node.text === target ? [] : null;
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) return assignmentSourcePropertyPath(node.left, target);
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        let child = null;
        let propertyName = null;
        if (ts.isPropertyAssignment(property)) {
          child = property.initializer;
          propertyName = resolvedPropertyName(property.name);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          child = property.name;
          propertyName = property.name.text;
        } else if (ts.isSpreadAssignment(property)) {
          return assignmentTargetIdentifier(property.expression, target) ? [] : null;
        }
        if (!child || !assignmentTargetIdentifier(child, target)) continue;
        const nested = assignmentSourcePropertyPath(child, target);
        return propertyName === null || nested === null
          ? null
          : [propertyName, ...nested];
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (let index = 0; index < node.elements.length; index += 1) {
        const element = node.elements[index];
        const child = ts.isSpreadElement(element) ? element.expression : element;
        if (!assignmentTargetIdentifier(child, target)) continue;
        if (ts.isSpreadElement(element)) return [`@array-rest:${index}`];
        const nested = assignmentSourcePropertyPath(child, target);
        return nested === null ? null : [String(index), ...nested];
      }
    }
    return null;
  }

  function bindingTargetRestKind(name, target) {
    if (ts.isIdentifier(name)) return null;
    for (const element of name.elements) {
      if (!ts.isBindingElement(element) || !bindingContains(element.name, target)) {
        continue;
      }
      if (element.dotDotDotToken) {
        return ts.isArrayBindingPattern(name) ? 'array' : 'object';
      }
      return bindingTargetRestKind(element.name, target);
    }
    return null;
  }

  function assignmentTargetRestKind(pattern, target) {
    const node = unwrap(pattern);
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) return assignmentTargetRestKind(node.left, target);
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const child = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isSpreadAssignment(property)
              ? property.expression
              : null;
        if (!child || !assignmentTargetIdentifier(child, target)) continue;
        if (ts.isSpreadAssignment(property)) return 'object';
        return assignmentTargetRestKind(child, target);
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        const child = ts.isSpreadElement(element) ? element.expression : element;
        if (!assignmentTargetIdentifier(child, target)) continue;
        if (ts.isSpreadElement(element)) return 'array';
        return assignmentTargetRestKind(child, target);
      }
    }
    return null;
  }

  function projectedAssignmentValue(pattern, target, value) {
    const node = unwrap(pattern);
    if (ts.isIdentifier(node)) return node.text === target ? value : null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let selected = value;
      if (
        ts.isOmittedExpression(unwrap(selected.expression))
        || isSemanticallyUndefined(selected.expression, selected.environment)
      ) {
        selected = { expression: node.right, environment: value.environment };
      }
      return projectedAssignmentValue(node.left, target, selected);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const objectInfo = resolveObjectLiteralInfo(
        value.expression,
        new Set(),
        value.environment,
      );
      if (!objectInfo) return null;
      for (const property of node.properties) {
        let child = null;
        let propertyName = null;
        if (ts.isPropertyAssignment(property)) {
          child = property.initializer;
          propertyName = resolvedPropertyName(property.name);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          child = property.name;
          propertyName = property.name.text;
        } else if (
          ts.isSpreadAssignment(property)
          && assignmentTargetIdentifier(property.expression, target)
        ) {
          return null;
        }
        if (!child || !assignmentTargetIdentifier(child, target) || propertyName === null) {
          continue;
        }
        const selected = objectPropertyValue(
          objectInfo.literal,
          propertyName,
          objectInfo.environment,
        );
        return selected ? projectedAssignmentValue(child, target, selected) : null;
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      const arrayInfo = resolveArrayLiteralInfo(
        value.expression,
        new Set(),
        value.environment,
      );
      if (!arrayInfo) return null;
      for (let index = 0; index < node.elements.length; index += 1) {
        const element = node.elements[index];
        const child = ts.isSpreadElement(element) ? element.expression : element;
        if (!assignmentTargetIdentifier(child, target)) continue;
        if (ts.isSpreadElement(element)) return null;
        const selected = arrayElementValue(
          arrayInfo.literal,
          index,
          arrayInfo.environment,
        );
        return selected ? projectedAssignmentValue(child, target, selected) : null;
      }
    }
    return null;
  }

  function callableAssignments(declaration, use) {
    const assignments = [];
    const usePosition = use.getStart(sourceFile);
    const useContainer = executionContainer(use);
    if (!allAssignmentExpressions) {
      allAssignmentExpressions = [];
      function collect(node) {
        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) allAssignmentExpressions.push(node);
        ts.forEachChild(node, collect);
      }
      collect(sourceFile);
    }
    for (const assignmentExpression of allAssignmentExpressions) {
        const assignedIdentifier = assignmentTargetIdentifier(
          assignmentExpression.left,
          use.text,
        );
        const container = executionContainer(assignmentExpression);
        if (
          assignedIdentifier
          && resolveLexicalVariableDeclaration(assignedIdentifier) === declaration
          && (
            (
              container === useContainer
              && assignmentExpression.getStart(sourceFile) < usePosition
            )
            || (container !== useContainer && isAncestor(container, use))
          )
        ) {
          assignments.push({
            node: assignmentExpression,
            external: isPureDynamicImportExpression(assignmentExpression.right)
              && !patternHasDefaultTarget(assignmentExpression.left, use.text),
            value: projectedAssignmentValue(
              assignmentExpression.left,
              use.text,
              { expression: assignmentExpression.right, environment: new Map() },
            ),
          });
        }
    }
    return assignments.sort(
      (left, right) => (
        left.node.getStart(sourceFile) - right.node.getStart(sourceFile)
      ),
    );
  }

  function containsDynamicImport(node) {
    let found = false;
    function visit(current) {
      if (found) return;
      if (
        ts.isCallExpression(current)
        && current.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    return found;
  }

  function isPureDynamicImportExpression(expression) {
    const node = unwrap(expression);
    if (ts.isAwaitExpression(node)) {
      return isPureDynamicImportExpression(node.expression);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return isPureDynamicImportExpression(node.expression);
    }
    if (ts.isElementAccessExpression(node)) {
      return Boolean(
        node.argumentExpression
        && (
          ts.isStringLiteral(node.argumentExpression)
          || ts.isNumericLiteral(node.argumentExpression)
          || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
        )
        && isPureDynamicImportExpression(node.expression)
      );
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'then'
      && isPureDynamicImportExpression(node.expression.expression)
      && node.arguments.length === 1
      && (
        ts.isArrowFunction(node.arguments[0])
        || ts.isFunctionExpression(node.arguments[0])
      )
      && node.arguments[0].parameters.length === 1
    ) {
      const selector = node.arguments[0];
      const safeLocals = new Set();
      function pureSelectorBinding(name) {
        if (ts.isIdentifier(name)) return true;
        return name.elements.every((element) => {
          if (!ts.isBindingElement(element) || element.initializer) return false;
          if (
            element.propertyName
            && resolvedPropertyName(element.propertyName) === null
          ) return false;
          return pureSelectorBinding(element.name);
        });
      }
      function pureSelectorExpression(candidate) {
        const root = unwrap(candidate);
        if (ts.isPropertyAccessExpression(root)) {
          return pureSelectorExpression(root.expression);
        }
        if (ts.isElementAccessExpression(root)) {
          return Boolean(
            root.argumentExpression
            && (
              ts.isStringLiteral(root.argumentExpression)
              || ts.isNumericLiteral(root.argumentExpression)
              || ts.isNoSubstitutionTemplateLiteral(root.argumentExpression)
            )
            && pureSelectorExpression(root.expression)
          );
        }
        return ts.isIdentifier(root)
          && (
            bindingContains(selector.parameters[0].name, root.text)
            || safeLocals.has(root.text)
          );
      }
      if (!pureSelectorBinding(selector.parameters[0].name)) return false;
      if (!ts.isBlock(selector.body)) {
        return pureSelectorExpression(selector.body);
      }
      const statements = [...selector.body.statements];
      const returned = statements.pop();
      if (
        !returned
        || !ts.isReturnStatement(returned)
        || !returned.expression
      ) return false;
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) return false;
        for (const declaration of statement.declarationList.declarations) {
          if (
            !pureSelectorBinding(declaration.name)
            || !declaration.initializer
            || !pureSelectorExpression(declaration.initializer)
          ) return false;
          collectBindingNames(declaration.name, safeLocals);
        }
      }
      return pureSelectorExpression(returned.expression);
    }
    return ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword;
  }

  function reportAmbiguousCallable(identifier) {
    let callee = identifier;
    while (
      callee.parent
      && (
        ts.isParenthesizedExpression(callee.parent)
        || ts.isAsExpression(callee.parent)
        || ts.isTypeAssertionExpression(callee.parent)
        || ts.isNonNullExpression(callee.parent)
        || ts.isSatisfiesExpression(callee.parent)
      )
      && callee.parent.expression === callee
    ) callee = callee.parent;
    if (!ts.isCallExpression(callee.parent) || callee.parent.expression !== callee) return;
    const message = 'assigned helper call cannot be analyzed safely';
    const key = `${identifier.getStart(sourceFile)}:${message}`;
    if (hookIssueKeys.has(key)) return;
    hookIssueKeys.add(key);
    issues.push({ line: lineOf(sourceFile, identifier), message });
  }

  function reportAssignedRestHelper(node) {
    const message = 'assigned rest helper call cannot be analyzed safely';
    const key = `${node.getStart(sourceFile)}:${message}`;
    if (hookIssueKeys.has(key)) return;
    hookIssueKeys.add(key);
    issues.push({ line: lineOf(sourceFile, node), message });
  }

  function resolveCallableExpression(expression, seen, environment = new Map()) {
    const raw = unwrap(expression);
    const value = ts.isIdentifier(raw)
      ? resolveEnvironmentExpression(raw, environment)
      : raw;
    if (
      ts.isArrowFunction(value)
      || ts.isFunctionExpression(value)
      || ts.isMethodDeclaration(value)
    ) {
      helperCapturedEnvironments.set(value, environment);
      return value;
    }
    if (ts.isIdentifier(value)) {
      const callable = resolveFunctionIdentifier(value, seen);
      if (callable && environment.size > 0) {
        helperCapturedEnvironments.set(callable, environment);
      }
      return callable;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      return resolvePropertyFunction(value, environment);
    }
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
      const factory = resolveFunctionIdentifier(value.expression, seen);
      const returns = factory ? guaranteedReturnExpressions(factory) : null;
      if (factory && returns?.length === 1) {
        const factoryEnvironment = callEnvironment(factory, value, environment);
        const returned = resolveEnvironmentExpression(returns[0], factoryEnvironment);
        const callable = resolveCallableExpression(returned, seen, factoryEnvironment);
        if (callable) helperCapturedEnvironments.set(callable, factoryEnvironment);
        return callable;
      }
    }
    return null;
  }

  function callableCandidate(callable, external = false) {
    if (!callable) {
      return {
        callable: null,
        environment: new Map(),
        external,
        key: external ? 'external' : 'unresolved',
      };
    }
    const environment = new Map(helperCapturedEnvironments.get(callable) ?? []);
    const environmentKey = [...environment]
      .map(([parameter, argument]) => {
        const expression = argument?.expression;
        const expressionKey = expression
          ? `${expression.getStart(sourceFile)}:${expression.getText(sourceFile)}`
          : argument?.definitelyUndefined
            ? 'undefined'
            : 'missing';
        return `${parameter.getStart(sourceFile)}=${expressionKey}`;
      })
      .sort()
      .join('|');
    return {
      callable,
      environment,
      external: false,
      key: `${callable.getStart(sourceFile)}:${environmentKey}`,
    };
  }

  function isFreshLocalMock(expression, environment = new Map(), seen = new Set()) {
    const node = unwrap(expression);
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'vi'
      && node.expression.name.text === 'fn'
    ) return true;
    if (!ts.isIdentifier(node)) return false;
    const parameter = parameterDeclarationFor(node);
    const argument = parameter ? environment.get(parameter) : null;
    if (argument?.expression && !seen.has(parameter)) {
      const nextSeen = new Set(seen);
      nextSeen.add(parameter);
      return isFreshLocalMock(argument.expression, argument.environment, nextSeen);
    }
    const declaration = resolveLexicalVariableDeclaration(node);
    if (
      !declaration?.initializer
      || seen.has(declaration)
      || !testCallbacks.some(({ callback }) => isAncestor(callback, declaration))
    ) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    const projected = projectedBindingValue(
      declaration.name,
      node.text,
      { expression: declaration.initializer, environment },
    );
    return Boolean(
      projected
      && isFreshLocalMock(
        projected.expression,
        projected.environment,
        nextSeen,
      )
    );
  }

  function candidateMayMutateShared(candidate) {
    let unsafe = false;
    function visit(node) {
      if (unsafe || (node !== candidate.callable && isFunctionNode(node))) return;
      if (
        ts.isCallExpression(node)
        && (
          ts.isPropertyAccessExpression(node.expression)
          || ts.isElementAccessExpression(node.expression)
        )
        && persistentMockMethods.has(memberName(node.expression))
      ) {
        const receiver = unwrap(node.expression.expression);
        const root = callRootName(receiver);
        if (!root) {
          unsafe = true;
          return;
        }
        const parameter = candidate.callable.parameters.find(
          (entry) => bindingContains(entry.name, root),
        ) ?? [...candidate.environment.keys()].find(
          (entry) => bindingContains(entry.name, root),
        );
        const argument = parameter ? candidate.environment.get(parameter) : null;
        if (
          argument?.expression
          && isFreshLocalMock(argument.expression, argument.environment)
        ) return;
        if (ts.isIdentifier(receiver)) {
          const declaration = resolveLexicalVariableDeclaration(receiver);
          if (
            declaration?.initializer
            && isAncestor(candidate.callable, declaration)
            && isFreshLocalMock(declaration.initializer, candidate.environment)
          ) return;
        }
        unsafe = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(candidate.callable);
    return unsafe;
  }

  function outerAssignmentDominatesCallback(assignment, use) {
    const assignmentContainer = executionContainer(assignment);
    if (
      assignmentContainer === executionContainer(use)
      || !isAncestor(assignmentContainer, use)
    ) return false;
    let statement = assignment;
    while (statement.parent && statement.parent !== assignmentContainer) {
      if (
        ts.isIfStatement(statement.parent)
        || ts.isConditionalExpression(statement.parent)
        || ts.isSwitchStatement(statement.parent)
        || ts.isTryStatement(statement.parent)
        || ts.isForStatement(statement.parent)
        || ts.isForInStatement(statement.parent)
        || ts.isForOfStatement(statement.parent)
        || ts.isWhileStatement(statement.parent)
        || ts.isDoStatement(statement.parent)
        || (
          ts.isBinaryExpression(statement.parent)
          && [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(statement.parent.operatorToken.kind)
        )
      ) return false;
      statement = statement.parent;
    }
    return true;
  }

  function resolveFunctionIdentifier(identifier, seen = new Set()) {
    let current = identifier.parent;
    while (current) {
      if (
        ts.isCatchClause(current)
        && current.variableDeclaration
        && bindingContains(current.variableDeclaration.name, identifier.text)
      ) return null;
      if (
        (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current))
        && current.initializer
        && ts.isVariableDeclarationList(current.initializer)
        && current.initializer.declarations.some(
          (declaration) => bindingContains(declaration.name, identifier.text),
        )
      ) return null;
      if (
        isFunctionNode(current)
        && current.parameters.some((parameter) => bindingContains(parameter.name, identifier.text))
      ) return null;
      if (ts.isBlock(current) || ts.isSourceFile(current)) {
        for (const statement of current.statements) {
          if (
            ts.isFunctionDeclaration(statement)
            && statement.name?.text === identifier.text
          ) return statement;
          if (ts.isClassDeclaration(statement) && statement.name?.text === identifier.text) {
            return null;
          }
          if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
              if (!bindingContains(declaration.name, identifier.text)) continue;
              if (seen.has(declaration)) return null;
              const nextSeen = new Set(seen);
              nextSeen.add(declaration);
              const candidates = [];
              const initializer = bindingInitializerValue(declaration, identifier.text);
              if (initializer) {
                candidates.push(callableCandidate(
                  resolveCallableExpression(
                    initializer.expression,
                    nextSeen,
                    initializer.environment,
                  ),
                ));
              } else if (declaration.initializer) {
                const source = unwrap(declaration.initializer);
                if (ts.isIdentifier(source) && hasAssignmentRestOrigin(source)) {
                  const propertyPath = bindingSourcePropertyPath(
                    declaration.name,
                    identifier.text,
                  );
                  if (
                    propertyPath === null
                    || restDispatchMayMutate(source, propertyPath)
                  ) reportAssignedRestHelper(identifier);
                }
              }
              const assignments = callableAssignments(declaration, identifier);
              for (const assignment of assignments) {
                const candidate = callableCandidate(
                  assignment.value
                    ? resolveCallableExpression(
                      assignment.value.expression,
                      nextSeen,
                      assignment.value.environment,
                    )
                    : null,
                  assignment.external,
                );
                if (
                  assignmentDominatesUse(assignment.node, identifier)
                  || outerAssignmentDominatesCallback(assignment.node, identifier)
                ) {
                  candidates.length = 0;
                  candidates.push(candidate);
                } else {
                  candidates.push(candidate);
                }
              }
              const unsafeDynamicInitializer = Boolean(
                declaration.initializer
                && containsDynamicImport(declaration.initializer)
                && (
                  !isPureDynamicImportExpression(declaration.initializer)
                  || bindingHasDefaultTarget(declaration.name, identifier.text)
                ),
              );
              if (unsafeDynamicInitializer && candidates.length === 0) {
                candidates.push(callableCandidate(null));
              }
              const resolved = [
                ...new Map(candidates.map((candidate) => [candidate.key, candidate])).values(),
              ];
              if (resolved.length === 1 && resolved[0].callable) {
                helperCapturedEnvironments.set(
                  resolved[0].callable,
                  resolved[0].environment,
                );
                return resolved[0].callable;
              }
              if (
                (
                  assignments.length > 0
                  || unsafeDynamicInitializer
                )
                && (
                  resolved.length > 1
                  || (resolved.length === 1 && !resolved[0].callable)
                )
              ) {
                if (
                  resolved.some(
                    (candidate) => (
                      (!candidate.callable && !candidate.external)
                      || (
                        candidate.callable
                        && candidateMayMutateShared(candidate)
                      )
                    ),
                  )
                ) reportAmbiguousCallable(identifier);
              }
              return null;
            }
          }
          if (ts.isImportDeclaration(statement) && statement.importClause) {
            const importedNames = new Set();
            if (statement.importClause.name) importedNames.add(statement.importClause.name.text);
            const bindings = statement.importClause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) importedNames.add(bindings.name.text);
            if (bindings && ts.isNamedImports(bindings)) {
              for (const element of bindings.elements) importedNames.add(element.name.text);
            }
            if (importedNames.has(identifier.text)) return null;
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  function resolveLexicalVariableDeclaration(identifier) {
    let nearestFunctionParameter = null;
    let functionScope = identifier.parent;
    while (functionScope && !isFunctionNode(functionScope)) {
      functionScope = functionScope.parent;
    }
    if (functionScope && isFunctionNode(functionScope)) {
      nearestFunctionParameter = functionScope.parameters.find(
        (candidate) => bindingContains(candidate.name, identifier.text),
      ) ?? null;
    }
    let current = identifier.parent;
    while (current) {
      if (
        ts.isCatchClause(current)
        && current.variableDeclaration
        && bindingContains(current.variableDeclaration.name, identifier.text)
      ) return current.variableDeclaration;
      if (isFunctionNode(current)) {
        const parameter = current.parameters.find(
          (candidate) => bindingContains(candidate.name, identifier.text),
        );
        if (parameter) return parameter;
      }
      if (
        (
          ts.isForStatement(current)
          || ts.isForInStatement(current)
          || ts.isForOfStatement(current)
        )
        && current.initializer
        && ts.isVariableDeclarationList(current.initializer)
        && (
          current.initializer.flags
          & (ts.NodeFlags.Let | ts.NodeFlags.Const)
        )
      ) {
        const loopDeclaration = current.initializer.declarations.find(
          (candidate) => bindingContains(candidate.name, identifier.text),
        );
        if (loopDeclaration) return loopDeclaration;
      }
      if (
        ts.isBlock(current)
        || ts.isSourceFile(current)
        || ts.isCaseBlock(current)
      ) {
        const statements = ts.isCaseBlock(current)
          ? current.clauses.flatMap((clause) => [...clause.statements])
          : current.statements;
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (!bindingContains(declaration.name, identifier.text)) continue;
            if (
              nearestFunctionParameter
              && isFunctionScopedVarDeclaration(declaration)
            ) continue;
            return declaration;
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  function isFunctionScopedVarDeclaration(declaration) {
    return ts.isVariableDeclarationList(declaration.parent)
      && !(declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
  }

  function isFunctionScopedVariableIdentity(declaration) {
    return ts.isParameter(declaration)
      || isFunctionScopedVarDeclaration(declaration);
  }

  function declarationInitializerDominatesUse(declaration, use) {
    if (
      !declaration.initializer
      || declaration.initializer.getStart(sourceFile) >= use.getStart(sourceFile)
      || !ts.isVariableDeclarationList(declaration.parent)
    ) return false;
    const declarationList = declaration.parent;
    if (
      ts.isForStatement(declarationList.parent)
      && declarationList.parent.initializer === declarationList
      && isAncestor(declarationList.parent.statement, use)
    ) return true;
    if (!ts.isVariableStatement(declarationList.parent)) return false;
    const statement = declarationList.parent;
    const block = statement.parent;
    if (!ts.isBlock(block) && !ts.isSourceFile(block)) return false;
    let useStatement = use;
    while (useStatement.parent && useStatement.parent !== block) {
      useStatement = useStatement.parent;
    }
    if (useStatement.parent !== block) return false;
    if (useStatement === statement) {
      return declaration.getStart(sourceFile) < use.getStart(sourceFile);
    }
    const declarationIndex = block.statements.indexOf(statement);
    const useIndex = block.statements.indexOf(useStatement);
    return declarationIndex >= 0
      && useIndex >= 0
      && declarationIndex < useIndex;
  }

  function guaranteedReturnExpressions(functionNode) {
    if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body)) {
      return [functionNode.body];
    }
    if (functionNode.body && ts.isBlock(functionNode.body)) {
      const statements = [...functionNode.body.statements];
      const returned = statements.at(-1);
      if (
        returned
        && ts.isReturnStatement(returned)
        && returned.expression
        && statements.slice(0, -1).every(
          (statement) => (
            ts.isVariableStatement(statement)
            || ts.isFunctionDeclaration(statement)
          ),
        )
      ) return [returned.expression];
    }
    return null;
  }

  function callEnvironment(factory, call, environment) {
    const mapped = new Map(environment);
    for (let index = 0; index < factory.parameters.length; index += 1) {
      const parameter = factory.parameters[index];
      const supplied = call.arguments[index];
      const definitelyUndefined = !supplied
        || isSemanticallyUndefined(supplied, environment);
      const usesDefault = !supplied
        || !isDefinitelyNonUndefinedExpression(supplied, environment);
      mapped.set(parameter, {
        expression: (definitelyUndefined ? parameter.initializer : supplied) ?? null,
        position: call.getStart(sourceFile),
        environment: definitelyUndefined ? mapped : environment,
        usesDefault,
        definitelyUndefined: definitelyUndefined && !parameter.initializer,
      });
    }
    return mapped;
  }

  function resolveObjectLiteralInfo(expression, seen = new Set(), environment = new Map()) {
    const node = resolveEnvironmentExpression(unwrap(expression), environment);
    if (ts.isObjectLiteralExpression(node)) return { literal: node, environment };
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const factory = resolveFunctionIdentifier(node.expression);
      const returns = factory ? guaranteedReturnExpressions(factory) : null;
      if (!factory || !returns || returns.length !== 1 || seen.has(factory)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(factory);
      return resolveObjectLiteralInfo(
        returns[0],
        nextSeen,
        callEnvironment(factory, node, environment),
      );
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = resolveLexicalVariableDeclaration(node);
    if (!declaration?.initializer || seen.has(declaration)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    return resolveObjectLiteralInfo(declaration.initializer, nextSeen, environment);
  }

  function resolveObjectLiteral(expression, seen = new Set(), environment = new Map()) {
    return resolveObjectLiteralInfo(expression, seen, environment)?.literal ?? null;
  }

  function resolveArrayLiteralInfo(expression, seen = new Set(), environment = new Map()) {
    const node = resolveEnvironmentExpression(unwrap(expression), environment);
    if (ts.isArrayLiteralExpression(node)) return { literal: node, environment };
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const factory = resolveFunctionIdentifier(node.expression);
      const returns = factory ? guaranteedReturnExpressions(factory) : null;
      if (!factory || !returns || returns.length !== 1 || seen.has(factory)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(factory);
      return resolveArrayLiteralInfo(
        returns[0],
        nextSeen,
        callEnvironment(factory, node, environment),
      );
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = resolveLexicalVariableDeclaration(node);
    if (!declaration?.initializer || seen.has(declaration)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    return resolveArrayLiteralInfo(declaration.initializer, nextSeen, environment);
  }

  function resolveArrayLiteral(expression, seen = new Set(), environment = new Map()) {
    return resolveArrayLiteralInfo(expression, seen, environment)?.literal ?? null;
  }

  function resolvedPropertyName(name) {
    if (!name) return null;
    if (
      ts.isIdentifier(name)
      || ts.isStringLiteral(name)
      || ts.isNumericLiteral(name)
    ) return name.text;
    if (!ts.isComputedPropertyName(name)) return null;
    const expression = unwrap(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
    if (!ts.isIdentifier(expression)) return null;
    const declaration = resolveLexicalVariableDeclaration(expression);
    if (
      !declaration?.initializer
      || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)
    ) return null;
    const initializer = unwrap(declaration.initializer);
    return ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer)
      ? initializer.text
      : null;
  }

  function isDefinitelyNonCallableExpression(expression, environment) {
    const node = unwrap(expression);
    return ts.isStringLiteralLike(node)
      || ts.isNumericLiteral(node)
      || ts.isBigIntLiteral(node)
      || ts.isObjectLiteralExpression(node)
      || ts.isArrayLiteralExpression(node)
      || ts.isTemplateExpression(node)
      || ts.isPrefixUnaryExpression(node)
      || ts.isVoidExpression(node)
      || isSemanticallyUndefined(node, environment)
      || [
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
      ].includes(node.kind);
  }

  function objectPropertyExpression(objectLiteral, propertyName) {
    for (const property of objectLiteral.properties) {
      const name = resolvedPropertyName(property.name);
      if (name !== propertyName) continue;
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
      if (ts.isMethodDeclaration(property)) return property;
    }
    return null;
  }

  function objectPropertyValue(
    objectLiteral,
    propertyName,
    environment,
    seen = new Set(),
  ) {
    for (let index = objectLiteral.properties.length - 1; index >= 0; index -= 1) {
      const property = objectLiteral.properties[index];
      const name = resolvedPropertyName(property.name);
      if (name === propertyName) {
        const expression = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isMethodDeclaration(property)
              ? property
              : null;
        return expression ? { expression, environment } : null;
      }
      if (ts.isSpreadAssignment(property) && !seen.has(property)) {
        const nextSeen = new Set(seen);
        nextSeen.add(property);
        const spread = resolveObjectLiteralInfo(
          property.expression,
          nextSeen,
          environment,
        );
        if (!spread) continue;
        const value = objectPropertyValue(
          spread.literal,
          propertyName,
          spread.environment,
          nextSeen,
        );
        if (value) return value;
      }
    }
    return null;
  }

  function arrayElementValue(arrayLiteral, targetIndex, environment, seen = new Set()) {
    let outputIndex = 0;
    for (const element of arrayLiteral.elements) {
      if (ts.isSpreadElement(element)) {
        if (seen.has(element)) return null;
        const nextSeen = new Set(seen);
        nextSeen.add(element);
        const spread = resolveArrayLiteralInfo(
          element.expression,
          nextSeen,
          environment,
        );
        if (!spread) return null;
        for (let index = 0; index < spread.literal.elements.length; index += 1) {
          if (outputIndex === targetIndex) {
            return arrayElementValue(
              spread.literal,
              index,
              spread.environment,
              nextSeen,
            );
          }
          outputIndex += 1;
        }
        continue;
      }
      if (outputIndex === targetIndex) return { expression: element, environment };
      outputIndex += 1;
    }
    return null;
  }

  function resolveEnvironmentExpression(expression, environment, seen = new Set()) {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const parameter = parameterDeclarationFor(node);
      const argument = parameter ? environment.get(parameter) : null;
      if (!argument?.expression || seen.has(parameter)) return node;
      const nextSeen = new Set(seen);
      nextSeen.add(parameter);
      return resolveEnvironmentExpression(argument.expression, argument.environment, nextSeen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = resolveEnvironmentExpression(node.expression, environment, seen);
      const objectInfo = resolveObjectLiteralInfo(base, new Set(), environment);
      const propertyName = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : (
          node.argumentExpression
          && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
            ? node.argumentExpression.text
            : null
        );
      if (objectInfo && propertyName !== null) {
        return objectPropertyValue(
          objectInfo.literal,
          propertyName,
          objectInfo.environment,
        )?.expression ?? node;
      }
      const arrayInfo = resolveArrayLiteralInfo(base, new Set(), environment);
      const index = Number(propertyName);
      if (arrayInfo && propertyName !== null && Number.isInteger(index)) {
        return arrayElementValue(
          arrayInfo.literal,
          index,
          arrayInfo.environment,
        )?.expression ?? node;
      }
    }
    return node;
  }

  function assignmentRestInfo(pattern, target) {
    const node = unwrap(pattern);
    if (ts.isObjectLiteralExpression(node)) {
      const excluded = new Set();
      for (const property of node.properties) {
        if (
          ts.isSpreadAssignment(property)
          && assignmentTargetIdentifier(property.expression, target)
        ) return { kind: 'object', excluded };
        if (
          ts.isPropertyAssignment(property)
          || ts.isShorthandPropertyAssignment(property)
        ) {
          const name = resolvedPropertyName(property.name);
          if (name !== null) excluded.add(name);
          if (
            ts.isPropertyAssignment(property)
            && assignmentTargetIdentifier(property.initializer, target)
          ) {
            const nested = assignmentRestInfo(property.initializer, target);
            if (nested) return nested;
          }
        }
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (
          ts.isSpreadElement(element)
          && assignmentTargetIdentifier(element.expression, target)
        ) return { kind: 'array', excluded: new Set() };
        const nested = assignmentRestInfo(
          ts.isSpreadElement(element) ? element.expression : element,
          target,
        );
        if (nested) return nested;
      }
    }
    return null;
  }

  function composeProjectionPath(prefix, suffix) {
    const combined = [...prefix, ...suffix];
    const result = [];
    for (let index = 0; index < combined.length; index += 1) {
      const segment = combined[index];
      if (!segment.startsWith('@array-rest:')) {
        result.push(segment);
        continue;
      }
      let offset = 0;
      while (
        index < combined.length
        && combined[index].startsWith('@array-rest:')
      ) {
        const currentOffset = Number(
          combined[index].slice('@array-rest:'.length),
        );
        if (!Number.isInteger(currentOffset)) return null;
        offset += currentOffset;
        index += 1;
      }
      const projected = combined[index];
      if (projected === '@dynamic') {
        result.push(projected);
        continue;
      }
      if (!projected || !/^\d+$/.test(projected)) {
        return null;
      }
      result.push(String(offset + Number(projected)));
    }
    return result;
  }

  function pathsPotentiallyEqual(left, right) {
    return left.length === right.length
      && left.every((segment, index) => (
        segment === right[index]
        || segment === '@dynamic'
        || right[index] === '@dynamic'
      ));
  }

  function pathsExactlyEqual(left, right) {
    return left.length === right.length
      && left.every((segment, index) => segment === right[index]);
  }

  function pathPotentiallyPrefixes(candidate, target) {
    return candidate.length <= target.length
      && candidate.every((segment, index) => (
        segment === target[index]
        || segment === '@dynamic'
        || target[index] === '@dynamic'
      ));
  }

  function staticAccessRootAndPath(expression) {
    function staticElementKey(argument) {
      const node = unwrap(argument);
      if (
        ts.isStringLiteral(node)
        || ts.isNumericLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
      ) return node.text;
      if (ts.isIdentifier(node)) {
        const seen = new Set();
        function reachingLiteral(identifier) {
          const declaration = resolveLexicalVariableDeclaration(identifier);
          if (!declaration || seen.has(declaration)) return null;
          seen.add(declaration);
          let unsupportedWrite = false;
          function findUnsupportedWrite(current) {
            if (unsupportedWrite || current.getStart(sourceFile) >= identifier.getStart(sourceFile)) {
              return;
            }
            if (
              (
                ts.isPrefixUnaryExpression(current)
                || ts.isPostfixUnaryExpression(current)
              )
              && [
                ts.SyntaxKind.PlusPlusToken,
                ts.SyntaxKind.MinusMinusToken,
              ].includes(current.operator)
              && ts.isIdentifier(unwrap(current.operand))
              && resolveLexicalVariableDeclaration(unwrap(current.operand)) === declaration
            ) {
              unsupportedWrite = true;
              return;
            }
            if (
              ts.isVariableDeclaration(current)
              && current !== declaration
              && current.initializer
              && bindingContains(current.name, identifier.text)
              && isFunctionScopedVarDeclaration(current)
              && isFunctionScopedVariableIdentity(declaration)
              && executionContainer(current) === executionContainer(identifier)
            ) {
              unsupportedWrite = true;
              return;
            }
            if (
              (
                ts.isForInStatement(current)
                || ts.isForOfStatement(current)
              )
            ) {
              const initializer = current.initializer;
              let writesDirectTarget = false;
              if (!ts.isVariableDeclarationList(initializer)) {
                const loopTarget = assignmentTargetIdentifier(
                  initializer,
                  identifier.text,
                );
                writesDirectTarget = Boolean(
                  loopTarget
                  && resolveLexicalVariableDeclaration(loopTarget) === declaration,
                );
              }
              const redeclaresFunctionScopedTarget = (
                ts.isVariableDeclarationList(initializer)
                && !(initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))
                && isFunctionScopedVariableIdentity(declaration)
                && executionContainer(current) === executionContainer(identifier)
                && initializer.declarations.some(
                  (loopDeclaration) => (
                    bindingContains(loopDeclaration.name, identifier.text)
                  ),
                )
              );
              if (writesDirectTarget || redeclaresFunctionScopedTarget) {
                unsupportedWrite = true;
                return;
              }
            }
            if (
              ts.isBinaryExpression(current)
              && current.operatorToken.kind !== ts.SyntaxKind.EqualsToken
              && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
              && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              && ts.isIdentifier(unwrap(current.left))
              && resolveLexicalVariableDeclaration(unwrap(current.left)) === declaration
            ) {
              unsupportedWrite = true;
              return;
            }
            ts.forEachChild(current, findUnsupportedWrite);
          }
          findUnsupportedWrite(sourceFile);
          if (unsupportedWrite) return null;
          let value = declarationInitializerDominatesUse(
            declaration,
            identifier,
          )
            ? declaration.initializer
            : null;
          for (const assignment of callableAssignments(declaration, identifier)) {
            if (
              assignmentDominatesUse(assignment.node, identifier)
              || outerAssignmentDominatesCallback(assignment.node, identifier)
            ) value = assignment.node.right;
            else return null;
          }
          const resolved = value ? unwrap(value) : null;
          if (
            resolved
            && (
              ts.isStringLiteral(resolved)
              || ts.isNumericLiteral(resolved)
              || ts.isNoSubstitutionTemplateLiteral(resolved)
            )
          ) return resolved.text;
          return resolved && ts.isIdentifier(resolved)
            ? reachingLiteral(resolved)
            : null;
        }
        return reachingLiteral(node);
      }
      return null;
    }
    const path = [];
    let root = unwrap(expression);
    while (
      ts.isPropertyAccessExpression(root)
      || ts.isElementAccessExpression(root)
    ) {
      if (ts.isPropertyAccessExpression(root)) {
        path.unshift(root.name.text);
      } else if (root.argumentExpression) {
        const propertyName = staticElementKey(root.argumentExpression);
        path.unshift(propertyName ?? '@dynamic');
      } else {
        return null;
      }
      root = unwrap(root.expression);
    }
    return ts.isIdentifier(root) ? { root, path } : null;
  }

  function dedupeObjectIdentities(identities) {
    return identities.filter((identity, index) => (
      identities.findIndex((candidate) => (
        candidate.declaration === identity.declaration
        && candidate.path.length === identity.path.length
        && candidate.path.every(
          (segment, pathIndex) => segment === identity.path[pathIndex],
        )
        && candidate.capturedAt === identity.capturedAt
      )) === index
    ));
  }

  function restObjectIdentities(identifier, seen = new Set()) {
    const declaration = resolveLexicalVariableDeclaration(identifier);
    if (!declaration || seen.has(declaration)) {
      return declaration ? [{ declaration, path: [], capturedAt: null }] : [];
    }
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    let current = [{ declaration, path: [], capturedAt: null }];
    function applyProjection(sourceExpression, sourcePath, restKind) {
      if (sourcePath === null || restKind === 'object') {
        return [{ declaration, path: [], capturedAt: null }];
      }
      const source = staticAccessRootAndPath(sourceExpression);
      if (!source) return [{ declaration, path: [], capturedAt: null }];
      const addsProjection = source.path.length + sourcePath.length > 0;
      const projectionPosition = addsProjection
        ? sourceExpression.getStart(sourceFile)
        : null;
      if (source.root.text === identifier.text) {
        return current.map((identity) => ({
          declaration: identity.declaration,
          path: [...identity.path, ...source.path, ...sourcePath],
          capturedAt: identity.capturedAt ?? projectionPosition,
        }));
      }
      const origins = restObjectIdentities(source.root, nextSeen);
      if (origins.length === 0) {
        return [{ declaration, path: [], capturedAt: null }];
      }
      return origins.flatMap((origin) => (
        origin.declaration === declaration
          ? current.map((identity) => ({
            declaration: identity.declaration,
            path: [
              ...identity.path,
              ...origin.path,
              ...source.path,
              ...sourcePath,
            ],
            capturedAt: identity.capturedAt
              ?? origin.capturedAt
              ?? projectionPosition,
          }))
          : [{
            declaration: origin.declaration,
            path: [...origin.path, ...source.path, ...sourcePath],
            capturedAt: origin.capturedAt ?? projectionPosition,
          }]
      ));
    }
    if (declaration.initializer) {
      current = applyProjection(
        declaration.initializer,
        bindingSourcePropertyPath(declaration.name, identifier.text),
        bindingTargetRestKind(declaration.name, identifier.text),
      );
    }
    const assignments = callableAssignments(declaration, identifier);
    for (const assignment of assignments) {
      const projected = applyProjection(
        assignment.node.right,
        assignmentSourcePropertyPath(
          assignment.node.left,
          identifier.text,
        ),
        assignmentTargetRestKind(
          assignment.node.left,
          identifier.text,
        ),
      );
      if (
        assignmentDominatesUse(assignment.node, identifier)
        || outerAssignmentDominatesCallback(assignment.node, identifier)
      ) {
        current = projected;
      } else current = dedupeObjectIdentities([...current, ...projected]);
    }
    return dedupeObjectIdentities(current);
  }

  function restObjectIdentity(identifier) {
    return restObjectIdentities(identifier)[0] ?? null;
  }

  function restContainerIdentities(identifier, seen = new Set()) {
    const declaration = resolveLexicalVariableDeclaration(identifier);
    if (!declaration || seen.has(declaration)) return declaration ? [declaration] : [];
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    let current = [declaration];
    function projectedContainers(sourceExpression, restKind) {
      if (restKind) return [declaration];
      const source = staticAccessRootAndPath(sourceExpression);
      return source && source.path.length === 0
        ? restContainerIdentities(source.root, nextSeen)
        : [declaration];
    }
    if (declaration.initializer) {
      current = projectedContainers(
        declaration.initializer,
        bindingTargetRestKind(declaration.name, identifier.text),
      );
    }
    for (const assignment of callableAssignments(declaration, identifier)) {
      const projected = projectedContainers(
        assignment.node.right,
        assignmentTargetRestKind(assignment.node.left, identifier.text),
      );
      if (
        assignmentDominatesUse(assignment.node, identifier)
        || outerAssignmentDominatesCallback(assignment.node, identifier)
      ) current = projected;
      else current = [...new Set([...current, ...projected])];
    }
    return [...new Set(current)];
  }

  function restMemberAssignmentRisk(identifier, objectPath, propertyName, use) {
    const declaration = resolveLexicalVariableDeclaration(identifier);
    if (!declaration) return null;
    let targetIdentities = restObjectIdentities(identifier)
      .map((identity) => ({
        declaration: identity.declaration,
        path: composeProjectionPath(identity.path, objectPath),
        capturedAt: identity.capturedAt,
      }))
      .filter((identity) => identity.path !== null);
    if (targetIdentities.length === 0 && objectPath.length === 0) {
      targetIdentities = restContainerIdentities(identifier).map(
        (containerDeclaration) => ({ declaration: containerDeclaration, path: [] }),
      );
    }
    if (targetIdentities.length === 0) return null;
    if (!allAssignmentExpressions) {
      allAssignmentExpressions = [];
      function collect(node) {
        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) allAssignmentExpressions.push(node);
        ts.forEachChild(node, collect);
      }
      collect(sourceFile);
    }
    function capturedIdentityInvalidation(identity, targetPath) {
      if (identity.capturedAt === null || identity.capturedAt === undefined) {
        return null;
      }
      let state = null;
      for (const assignment of allAssignmentExpressions) {
        const position = assignment.getStart(sourceFile);
        if (position <= identity.capturedAt || position >= use.getStart(sourceFile)) {
          continue;
        }
        const access = staticAccessRootAndPath(assignment.left);
        if (!access) continue;
        let hasExactCapturedSlotWrite = false;
        let hasPossibleCapturedSlotWrite = false;
        for (const rootIdentity of restObjectIdentities(access.root)) {
          const assignedPath = composeProjectionPath(
            rootIdentity.path,
            access.path,
          );
          if (
            rootIdentity.declaration !== identity.declaration
            || assignedPath === null
            || !pathsPotentiallyEqual(assignedPath, targetPath)
          ) continue;
          if (pathsExactlyEqual(assignedPath, targetPath)) {
            hasExactCapturedSlotWrite = true;
          } else {
            hasPossibleCapturedSlotWrite = true;
          }
        }
        let capturedSlotWrite = null;
        if (hasExactCapturedSlotWrite) capturedSlotWrite = 'exact';
        if (hasPossibleCapturedSlotWrite) capturedSlotWrite = 'possible';
        if (!capturedSlotWrite) continue;
        const restored = staticAccessRootAndPath(assignment.right);
        const restoresCapturedIdentity = Boolean(
          restored
          && restObjectIdentities(restored.root).some((restoredIdentity) => {
            const restoredPath = composeProjectionPath(
              restoredIdentity.path,
              restored.path,
            );
            return restoredIdentity.declaration === identity.declaration
              && restoredPath !== null
              && pathsExactlyEqual(restoredPath, targetPath);
          })
        );
        const dominates = (
          assignmentDominatesUse(assignment, use)
          || outerAssignmentDominatesCallback(assignment, use)
        );
        if (dominates && capturedSlotWrite === 'exact') {
          state = restoresCapturedIdentity ? null : 'definite';
        } else {
          state = 'possible';
        }
      }
      return state;
    }
    let candidates = [];
    for (const assignment of allAssignmentExpressions) {
      const access = staticAccessRootAndPath(assignment.left);
      if (!access || access.path.length === 0) continue;
      const assignedProperty = access.path.at(-1);
      const receiverPath = access.path.slice(0, -1);
      let receiverIdentities = restObjectIdentities(access.root)
        .map((identity) => ({
          declaration: identity.declaration,
          path: composeProjectionPath(identity.path, receiverPath),
          capturedAt: identity.capturedAt,
        }))
        .filter((identity) => identity.path !== null);
      if (receiverIdentities.length === 0 && receiverPath.length === 0) {
        receiverIdentities = restContainerIdentities(access.root).map(
          (containerDeclaration) => ({
            declaration: containerDeclaration,
            path: [],
          }),
        );
      }
      const matchingReceiverIdentities = receiverIdentities.filter(
        (receiverIdentity) => targetIdentities.some((targetIdentity) => (
          receiverIdentity.declaration === targetIdentity.declaration
          && pathsPotentiallyEqual(
            receiverIdentity.path,
            targetIdentity.path,
          )
          && capturedIdentityInvalidation(
            receiverIdentity,
            targetIdentity.path,
          ) !== 'definite'
        )),
      );
      if (
        (
          assignedProperty !== propertyName
          && assignedProperty !== '@dynamic'
        )
        || matchingReceiverIdentities.length === 0
        || assignment.getStart(sourceFile) >= use.getStart(sourceFile)
      ) continue;
      const sameContainer = executionContainer(assignment) === executionContainer(use);
      if (
        !sameContainer
        && !isAncestor(executionContainer(assignment), use)
      ) continue;
      const candidate = resolveCallableExpression(
        assignment.right,
        new Set(),
        new Map(),
      );
      const risk = candidate
        ? candidateMayMutateShared(callableCandidate(candidate))
        : true;
      const possiblyInvalidated = matchingReceiverIdentities.some(
        (receiverIdentity) => targetIdentities.some((targetIdentity) => (
          receiverIdentity.declaration === targetIdentity.declaration
          && pathsPotentiallyEqual(
            receiverIdentity.path,
            targetIdentity.path,
          )
          && capturedIdentityInvalidation(
            receiverIdentity,
            targetIdentity.path,
          ) === 'possible'
        )),
      );
      const mustAlias = (
        assignedProperty === propertyName
        && !possiblyInvalidated
        && matchingReceiverIdentities.length === receiverIdentities.length
        && targetIdentities.every((targetIdentity) => (
          receiverIdentities.some((receiverIdentity) => (
            receiverIdentity.declaration === targetIdentity.declaration
            && pathsExactlyEqual(
              receiverIdentity.path,
              targetIdentity.path,
            )
          ))
        ))
      );
      if (
        mustAlias
        && (
          assignmentDominatesUse(assignment, use)
          || outerAssignmentDominatesCallback(assignment, use)
        )
      ) candidates = [{ risk, dominant: true }];
      else candidates.push({ risk, dominant: false });
    }
    if (candidates.length === 0) return null;
    return candidates.some((candidate) => candidate.dominant)
      ? candidates.some((candidate) => candidate.risk)
      : candidates.some((candidate) => candidate.risk) || null;
  }

  function assignmentPreservesObjectIdentity(assignment, target) {
    const assignedIdentifier = assignmentTargetIdentifier(assignment.left, target);
    const sourcePath = assignmentSourcePropertyPath(assignment.left, target);
    const source = staticAccessRootAndPath(assignment.right);
    if (!assignedIdentifier || sourcePath === null || !source) return false;
    const before = restObjectIdentity(assignedIdentifier);
    const sourceIdentity = restObjectIdentity(source.root);
    if (
      !before
      || !sourceIdentity
      || before.declaration !== sourceIdentity.declaration
    ) return false;
    const projectedSourcePath = [
      ...sourceIdentity.path,
      ...source.path,
      ...sourcePath,
    ];
    return before.path.length === projectedSourcePath.length
      && before.path.every(
        (segment, index) => segment === projectedSourcePath[index],
      );
  }

  function expressionPathMayMutate(expression, path) {
    let value = { expression, environment: new Map() };
    for (const propertyName of path) {
      const objectInfo = resolveObjectLiteralInfo(
        value.expression,
        new Set(),
        value.environment,
      );
      if (objectInfo) {
        value = objectPropertyValue(
          objectInfo.literal,
          propertyName,
          objectInfo.environment,
        );
      } else {
        const arrayInfo = resolveArrayLiteralInfo(
          value.expression,
          new Set(),
          value.environment,
        );
        value = arrayInfo && /^\d+$/.test(propertyName)
          ? arrayElementValue(
            arrayInfo.literal,
            Number(propertyName),
            arrayInfo.environment,
          )
          : null;
      }
      if (!value) return objectInfo ? false : true;
    }
    const callable = resolveCallableExpression(
      value.expression,
      new Set(),
      value.environment,
    );
    return callable
      ? candidateMayMutateShared(callableCandidate(callable))
      : false;
  }

  function restProjectedAssignmentRisk(identifier, path, use) {
    const declaration = resolveLexicalVariableDeclaration(identifier);
    if (!declaration) return null;
    if (!allAssignmentExpressions) {
      allAssignmentExpressions = [];
      function collect(node) {
        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) allAssignmentExpressions.push(node);
        ts.forEachChild(node, collect);
      }
      collect(sourceFile);
    }
    let candidates = [];
    for (const assignment of allAssignmentExpressions) {
      const access = staticAccessRootAndPath(assignment.left);
      const rootIdentities = access ? restObjectIdentities(access.root) : [];
      const projectedEntries = access
        ? rootIdentities.map((identity) => ({
          identity,
          assignedPath: (
            identity.path.some((segment) => segment.startsWith('@array-rest:'))
            && access.path.length === 1
          )
            ? null
            : composeProjectionPath(identity.path, access.path),
        }))
        : [];
      const matchingEntries = projectedEntries.filter((entry) => (
        entry.identity.declaration === declaration
        && entry.assignedPath !== null
        && entry.assignedPath.length > 0
        && entry.assignedPath.length < path.length
        && pathPotentiallyPrefixes(entry.assignedPath, path)
      ));
      if (
        !access
        || matchingEntries.length === 0
        || assignment.getStart(sourceFile) >= use.getStart(sourceFile)
      ) continue;
      const assignedPath = matchingEntries
        .map((entry) => entry.assignedPath)
        .sort((left, right) => (
          right.length - left.length
          || Number(pathsExactlyEqual(right, path.slice(0, right.length)))
          - Number(pathsExactlyEqual(left, path.slice(0, left.length)))
        ))[0];
      const restored = staticAccessRootAndPath(assignment.right);
      const restoresTargetIdentity = Boolean(
        restored
        && restObjectIdentities(restored.root).some((identity) => {
          const restoredPath = composeProjectionPath(
            identity.path,
            restored.path,
          );
          return identity.declaration === declaration
            && restoredPath !== null
            && !assignedPath.includes('@dynamic')
            && pathsExactlyEqual(restoredPath, assignedPath);
        })
      );
      const risk = restoresTargetIdentity
        ? null
        : expressionPathMayMutate(
          assignment.right,
          path.slice(assignedPath.length),
        );
      if (
        matchingEntries.length === rootIdentities.length
        && matchingEntries.every((entry) => (
          pathsExactlyEqual(
            entry.assignedPath,
            path.slice(0, entry.assignedPath.length),
          )
        ))
        && (
          assignmentDominatesUse(assignment, use)
          || outerAssignmentDominatesCallback(assignment, use)
        )
      ) candidates = [{ risk, dominant: true }];
      else candidates.push({ risk, dominant: false });
    }
    if (candidates.length === 0) return null;
    if (!candidates.some((candidate) => candidate.dominant)) {
      return candidates.some((candidate) => candidate.risk) || null;
    }
    if (candidates.some((candidate) => candidate.risk === true)) return true;
    if (candidates.some((candidate) => candidate.risk === null)) return null;
    return false;
  }

  function restDispatchMayMutate(
    identifier,
    propertyPath,
    seen = new Set(),
    use = identifier,
  ) {
    const path = Array.isArray(propertyPath) ? [...propertyPath] : [propertyPath];
    if (path.length === 0) return true;
    const projectedAssignmentRisk = restProjectedAssignmentRisk(
      identifier,
      path,
      use,
    );
    if (projectedAssignmentRisk !== null) return projectedAssignmentRisk;
    const memberRisk = restMemberAssignmentRisk(
      identifier,
      path.slice(0, -1),
      path.at(-1),
      use,
    );
    if (memberRisk !== null) return memberRisk;
    const declaration = resolveLexicalVariableDeclaration(identifier);
    const stateKey = declaration
      ? `${declaration.pos}:${identifier.getStart(sourceFile)}`
      : null;
    if (!declaration || seen.has(stateKey)) return true;
    const nextSeen = new Set(seen);
    nextSeen.add(stateKey);
    let candidates = declaration.initializer
      ? [{
        expression: declaration.initializer,
        environment: new Map(),
        rest: null,
        sourcePath: bindingSourcePropertyPath(declaration.name, identifier.text),
      }]
      : [];
    for (const assignment of callableAssignments(declaration, identifier)) {
      if (assignmentPreservesObjectIdentity(assignment.node, identifier.text)) {
        continue;
      }
      const candidate = {
        expression: assignment.node.right,
        environment: new Map(),
        rest: assignmentRestInfo(assignment.node.left, identifier.text),
        sourcePath: assignmentSourcePropertyPath(
          assignment.node.left,
          identifier.text,
        ),
      };
      if (
        assignmentDominatesUse(assignment.node, identifier)
        || outerAssignmentDominatesCallback(assignment.node, identifier)
      ) candidates = [candidate];
      else candidates.push(candidate);
    }
    if (candidates.length === 0) return false;
    return candidates.some((candidate) => {
      if (
        candidate.rest?.kind === 'object'
        && candidate.rest.excluded.has(path[0])
      ) return false;
      const candidatePath = candidate.sourcePath === null
        ? null
        : composeProjectionPath(candidate.sourcePath, path);
      if (candidatePath === null) return true;
      const expression = unwrap(candidate.expression);
      const access = staticAccessRootAndPath(expression);
      if (access) {
        const capturesProjectedValue = access.path.length > 0
          || candidate.sourcePath.length > 0;
        return restDispatchMayMutate(
          access.root,
          [...access.path, ...candidatePath],
          nextSeen,
          capturesProjectedValue ? candidate.expression : use,
        );
      }
      let value = {
        expression: candidate.expression,
        environment: candidate.environment,
      };
      for (const propertyName of candidatePath) {
        const objectInfo = resolveObjectLiteralInfo(
          value.expression,
          new Set(),
          value.environment,
        );
        if (objectInfo) {
          value = objectPropertyValue(
            objectInfo.literal,
            propertyName,
            objectInfo.environment,
          );
        } else {
          const arrayInfo = resolveArrayLiteralInfo(
            value.expression,
            new Set(),
            value.environment,
          );
          value = arrayInfo && /^\d+$/.test(propertyName)
            ? arrayElementValue(
              arrayInfo.literal,
              Number(propertyName),
              arrayInfo.environment,
            )
            : null;
        }
        if (!value) return objectInfo ? false : true;
      }
      const callable = resolveCallableExpression(
        value.expression,
        new Set(),
        value.environment,
      );
      return callable
        ? candidateMayMutateShared(callableCandidate(callable))
        : false;
    });
  }

  function hasAssignmentRestOrigin(identifier, seen = new Set()) {
    const declaration = resolveLexicalVariableDeclaration(identifier);
    if (!declaration || seen.has(declaration)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    if (declaration.initializer) {
      const source = staticAccessRootAndPath(declaration.initializer);
      if (source && hasAssignmentRestOrigin(source.root, nextSeen)) return true;
    }
    for (const assignment of callableAssignments(declaration, identifier)) {
      if (assignmentRestInfo(assignment.node.left, identifier.text)) return true;
      const source = staticAccessRootAndPath(assignment.node.right);
      if (source && hasAssignmentRestOrigin(source.root, nextSeen)) return true;
    }
    return false;
  }

  function resolvePropertyFunction(
    propertyAccess,
    environment = new Map(),
    seen = new Set(),
  ) {
    if (
      !ts.isPropertyAccessExpression(propertyAccess)
      && !ts.isElementAccessExpression(propertyAccess)
    ) return null;
    const container = resolveEnvironmentExpression(
      propertyAccess.expression,
      environment,
    );
    const objectInfo = resolveObjectLiteralInfo(container, new Set(), environment);
    if (!objectInfo) {
      const path = [];
      let root = unwrap(propertyAccess);
      let dynamic = false;
      while (
        ts.isPropertyAccessExpression(root)
        || ts.isElementAccessExpression(root)
      ) {
        if (ts.isPropertyAccessExpression(root)) {
          path.unshift(root.name.text);
        } else if (
          root.argumentExpression
          && (
            ts.isStringLiteral(root.argumentExpression)
            || ts.isNumericLiteral(root.argumentExpression)
            || ts.isNoSubstitutionTemplateLiteral(root.argumentExpression)
          )
        ) {
          path.unshift(root.argumentExpression.text);
        } else {
          dynamic = true;
        }
        root = unwrap(root.expression);
      }
      if (
        ts.isIdentifier(root)
        && hasAssignmentRestOrigin(root)
        && (
          dynamic
          || restDispatchMayMutate(root, path, new Set(), propertyAccess)
        )
      ) {
        reportAssignedRestHelper(root);
      }
      return null;
    }
    const propertyName = ts.isPropertyAccessExpression(propertyAccess)
      ? propertyAccess.name.text
      : (
        propertyAccess.argumentExpression
        && (
          ts.isStringLiteral(propertyAccess.argumentExpression)
          || ts.isNumericLiteral(propertyAccess.argumentExpression)
        )
          ? propertyAccess.argumentExpression.text
          : null
    );
    if (propertyName === null) return null;
    for (let index = objectInfo.literal.properties.length - 1; index >= 0; index -= 1) {
      const candidate = objectInfo.literal.properties[index];
      const candidateName = resolvedPropertyName(candidate.name);
      if (candidateName === propertyName) break;
      const potentiallyCallable = ts.isMethodDeclaration(candidate)
        || (
          ts.isPropertyAssignment(candidate)
          && !isDefinitelyNonCallableExpression(
            candidate.initializer,
            objectInfo.environment,
          )
        );
      const unresolvedSpread = ts.isSpreadAssignment(candidate)
        && !resolveObjectLiteralInfo(
          candidate.expression,
          new Set(),
          objectInfo.environment,
        );
      if ((candidateName === null && potentiallyCallable) || unresolvedSpread) {
        const message = 'computed helper property cannot be analyzed safely';
        const key = `${candidate.getStart(sourceFile)}:${message}`;
        if (!hookIssueKeys.has(key)) {
          hookIssueKeys.add(key);
          issues.push({ line: lineOf(sourceFile, candidate), message });
        }
        return null;
      }
    }
    const property = objectPropertyValue(
      objectInfo.literal,
      propertyName,
      objectInfo.environment,
    );
    if (!property) {
      const unresolvedFunctionProperty = objectInfo.literal.properties.find((candidate) => (
        candidate.name
        && resolvedPropertyName(candidate.name) === null
        && (
          ts.isMethodDeclaration(candidate)
          || (
            ts.isPropertyAssignment(candidate)
            && (
              ts.isArrowFunction(unwrap(candidate.initializer))
              || ts.isFunctionExpression(unwrap(candidate.initializer))
            )
          )
        )
      ));
      if (unresolvedFunctionProperty) {
        const message = 'computed helper property cannot be analyzed safely';
        const key = `${unresolvedFunctionProperty.getStart(sourceFile)}:${message}`;
        if (!hookIssueKeys.has(key)) {
          hookIssueKeys.add(key);
          issues.push({
            line: lineOf(sourceFile, unresolvedFunctionProperty),
            message,
          });
        }
      }
      return null;
    }
    const value = unwrap(property.expression);
    if (
      ts.isMethodDeclaration(value)
      || ts.isArrowFunction(value)
      || ts.isFunctionExpression(value)
    ) {
      helperCapturedEnvironments.set(value, property.environment);
      return value;
    }
    if (ts.isIdentifier(value)) {
      const resolved = resolveFunctionIdentifier(value);
      if (resolved) helperCapturedEnvironments.set(resolved, property.environment);
      return resolved;
    }
    if (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
      && !seen.has(value)
    ) {
      const nextSeen = new Set(seen);
      nextSeen.add(value);
      return resolvePropertyFunction(value, property.environment, nextSeen);
    }
    return null;
  }

  function resolvePropertyHelper(call, environment = new Map()) {
    return (
      ts.isPropertyAccessExpression(call.expression)
      || ts.isElementAccessExpression(call.expression)
    )
      ? resolvePropertyFunction(call.expression, environment)
      : null;
  }

  function parameterDeclarationFor(identifier) {
    let current = identifier.parent;
    while (current) {
      if (isFunctionNode(current)) {
        for (const parameter of current.parameters) {
          if (bindingContains(parameter.name, identifier.text)) return parameter;
        }
      }
      current = current.parent;
    }
    return null;
  }

  function resolveCallableParameter(identifier, environment, seen = new Set()) {
    const parameter = parameterDeclarationFor(identifier);
    const argument = parameter ? environment.get(parameter) : null;
    if (!argument?.expression || seen.has(parameter)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(parameter);
    const expression = unwrap(argument.expression);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return expression;
    }
    if (ts.isIdentifier(expression)) {
      return resolveFunctionIdentifier(expression)
        ?? resolveCallableParameter(expression, argument.environment, nextSeen);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return resolvePropertyFunction(expression, argument.environment);
    }
    return null;
  }

  function isDefinitelyUndefinedExpression(expression) {
    const node = unwrap(expression);
    return (ts.isIdentifier(node) && node.text === 'undefined')
      || ts.isVoidExpression(node);
  }

  function isSemanticallyUndefined(expression, environment, seen = new Set()) {
    if (isDefinitelyUndefinedExpression(expression)) return true;
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) return false;
    const parameter = parameterDeclarationFor(node);
    const argument = parameter ? environment.get(parameter) : null;
    if (argument && !seen.has(parameter)) {
      if (argument.definitelyUndefined) return true;
      if (!argument.expression) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(parameter);
      return isSemanticallyUndefined(
        argument.expression,
        argument.environment,
        nextSeen,
      );
    }
    const declaration = resolveLexicalVariableDeclaration(node);
    if (
      declaration?.initializer
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const)
      && !seen.has(declaration)
    ) {
      const nextDeclarationSeen = new Set(seen);
      nextDeclarationSeen.add(declaration);
      return isSemanticallyUndefined(
        declaration.initializer,
        environment,
        nextDeclarationSeen,
      );
    }
    return false;
  }

  function isDefinitelyNonUndefinedExpression(
    expression,
    environment,
    seen = new Set(),
  ) {
    const node = unwrap(expression);
    if (
      ts.isStringLiteral(node)
      || ts.isNumericLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword
      || node.kind === ts.SyntaxKind.FalseKeyword
      || node.kind === ts.SyntaxKind.NullKeyword
      || ts.isObjectLiteralExpression(node)
      || ts.isArrayLiteralExpression(node)
      || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isClassExpression(node)
      || ts.isNewExpression(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
    ) return true;
    if (ts.isConditionalExpression(node)) {
      return isDefinitelyNonUndefinedExpression(node.whenTrue, environment, seen)
        && isDefinitelyNonUndefinedExpression(node.whenFalse, environment, seen);
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'vi'
      && ['fn', 'spyOn'].includes(node.expression.name.text)
    ) return true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const factory = resolveFunctionIdentifier(node.expression);
      const returns = factory ? guaranteedReturnExpressions(factory) : null;
      if (
        factory
        && returns
        && returns.length > 0
        && !seen.has(factory)
      ) {
        const nextSeen = new Set(seen);
        nextSeen.add(factory);
        const factoryEnvironment = callEnvironment(factory, node, environment);
        return returns.every((returned) => (
          isDefinitelyNonUndefinedExpression(returned, factoryEnvironment, nextSeen)
        ));
      }
    }
    if (!ts.isIdentifier(node)) return false;
    const parameter = parameterDeclarationFor(node);
    const argument = parameter ? environment.get(parameter) : null;
    if (argument) {
      if (argument.definitelyUndefined || !argument.expression || seen.has(parameter)) {
        return false;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(parameter);
      return isDefinitelyNonUndefinedExpression(
        argument.expression,
        argument.environment,
        nextSeen,
      );
    }
    const declaration = resolveLexicalVariableDeclaration(node);
    if (!declaration?.initializer || seen.has(declaration)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    return isDefinitelyNonUndefinedExpression(
      declaration.initializer,
      environment,
      nextSeen,
    );
  }

  function unresolvedLocalComputedHelper(call, environment) {
    const callee = unwrap(call.expression);
    if (
      !ts.isElementAccessExpression(callee)
      || !callee.argumentExpression
      || ts.isStringLiteral(callee.argumentExpression)
      || ts.isNumericLiteral(callee.argumentExpression)
    ) return false;
    const container = resolveEnvironmentExpression(callee.expression, environment);
    return !!resolveObjectLiteral(container, new Set(), environment);
  }

  function discover(node) {
    if (ts.isCallExpression(node)) {
      let name = callRootName(node.expression);
      if (
        name === 'test'
        && node.expression.getText(sourceFile).replace(/\s+/g, '').startsWith('test.describe')
      ) name = 'describe';
      const callback = callbackFromCall(node, resolveFunctionIdentifier);
      const callee = unwrap(node.expression);
      let registrationKind = null;
      if (ts.isIdentifier(callee) && ['it', 'test', 'describe'].includes(callee.text)) {
        registrationKind = callee.text;
      } else if (ts.isCallExpression(callee) && ['it', 'test', 'describe'].includes(name)) {
        registrationKind = name;
      } else if (ts.isPropertyAccessExpression(callee)) {
        const calleeText = callee.getText(sourceFile).replace(/\s+/g, '');
        const modifier = callee.name.text;
        if (calleeText === 'test.describe') {
          registrationKind = 'describe';
        } else if (
          ['only', 'skip', 'todo', 'concurrent', 'sequential', 'shuffle', 'fails'].includes(modifier)
          && ['it', 'test', 'describe'].includes(name)
        ) {
          registrationKind = name;
        }
      }
      if (callback && registrationKind === 'describe') {
        suiteCallbacks.add(callback);
        if (suiteRegistrations.has(callback)) {
          issues.push({
            line: lineOf(sourceFile, node),
            message: 'describe callback is registered multiple times and cannot be scoped safely',
          });
        } else {
          suiteRegistrations.set(callback, node);
        }
      }
      if (callback && (registrationKind === 'it' || registrationKind === 'test')) {
        testCallbacks.push({ callback, call: node });
      }
      if (callback && name === 'beforeEach') setupCallbacks.push({ callback, call: node });
      if (callback && name === 'afterEach') teardownCallbacks.push({ callback, call: node });
      if ((name === 'beforeEach' || name === 'afterEach') && !callback) {
        const candidate = node.arguments.at(-1);
        if (
          candidate
          && ts.isPropertyAccessExpression(candidate)
          && ts.isIdentifier(candidate.expression)
          && candidate.expression.text === 'vi'
          && ['clearAllMocks', 'resetAllMocks', 'restoreAllMocks'].includes(candidate.name.text)
        ) {
          const hook = { callback: null, call: node, directMethod: candidate.name.text };
          if (name === 'beforeEach') setupCallbacks.push(hook);
          else teardownCallbacks.push(hook);
        } else {
          issues.push({
            line: lineOf(sourceFile, node),
            message: `${name} callback cannot be analyzed; use an inline/local function or direct vi cleanup method`,
          });
        }
      }
      if (
        registrationKind
        && !callback
        && !(
          ts.isPropertyAccessExpression(callee)
          && ['todo', 'skip'].includes(callee.name.text)
          && node.arguments.length <= 1
        )
      ) {
        issues.push({
          line: lineOf(sourceFile, node),
          message: `${registrationKind} callback cannot be analyzed; use an inline or locally defined function`,
        });
      }
    }
    ts.forEachChild(node, discover);
  }
  discover(sourceFile);

  const insideTest = (node) => testCallbacks.some(
    ({ callback }) => node.getStart(sourceFile) >= callback.getStart(sourceFile)
      && node.getEnd() <= callback.getEnd(),
  );
  const sharedNames = new Set();

  function collectSharedDeclarations(node) {
    if (insideTest(node)) return;
    if (ts.isImportClause(node)) {
      if (node.name) sharedNames.add(node.name.text);
      if (node.namedBindings && ts.isNamespaceImport(node.namedBindings)) {
        sharedNames.add(node.namedBindings.name.text);
      } else if (node.namedBindings && ts.isNamedImports(node.namedBindings)) {
        for (const element of node.namedBindings.elements) sharedNames.add(element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, sharedNames);
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name
    ) sharedNames.add(node.name.text);
    ts.forEachChild(node, collectSharedDeclarations);
  }
  collectSharedDeclarations(sourceFile);

  function suitePath(node, resolving = new Set()) {
    const lexicalPath = [];
    let current = node.parent;
    while (current) {
      if (suiteCallbacks.has(current)) lexicalPath.push(current);
      current = current.parent;
    }
    const path = [];
    for (const suite of lexicalPath.reverse()) {
      const registration = suiteRegistrations.get(suite);
      if (registration && !resolving.has(suite)) {
        const nextResolving = new Set(resolving);
        nextResolving.add(suite);
        for (const outer of suitePath(registration, nextResolving)) {
          if (!path.includes(outer)) path.push(outer);
        }
      }
      if (!path.includes(suite)) path.push(suite);
    }
    return path;
  }

  function hookApplies(hook, test) {
    const hookPath = suitePath(hook.call);
    const testPath = suitePath(test.call);
    return hookPath.length <= testPath.length
      && hookPath.every((suite, index) => suite === testPath[index]);
  }

  function hasPotentialAbruptExitBefore(body, target) {
    let found = false;
    function visit(node) {
      if (
        found
        || node.getStart(sourceFile) >= target.getStart(sourceFile)
        || (node !== body && (isFunctionNode(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)))
      ) return;
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(body);
    return found;
  }

  function summarizeHooks(hooks) {
    const summary = {
      usesClearAllMocks: false,
      resetsAllMocks: false,
      restoresAllMocks: false,
      rearmed: new Set(),
      reset: new Set(),
      refreshedRoots: new Set(),
      refreshedKeys: new Set(),
    };
    function reportHookIssue(node, message) {
      const key = `${node.getStart(sourceFile)}:${message}`;
      if (hookIssueKeys.has(key)) return;
      hookIssueKeys.add(key);
      issues.push({ line: lineOf(sourceFile, node), message });
    }
    function mappedHookText(expression, environment, seen = new Set()) {
      const node = unwrap(expression);
      if (ts.isIdentifier(node)) {
        const parameter = parameterDeclarationFor(node);
        const argument = parameter ? environment.get(parameter) : null;
        if (parameter) {
          if (!argument?.expression || seen.has(parameter)) return null;
          const nextSeen = new Set(seen);
          nextSeen.add(parameter);
          return mappedHookText(argument.expression, argument.environment, nextSeen);
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        const base = mappedHookText(node.expression, environment, seen);
        return base ? `${base}.${node.name.text}` : null;
      }
      if (ts.isElementAccessExpression(node)) {
        const base = mappedHookText(node.expression, environment, seen);
        const suffix = node.argumentExpression
          ? node.argumentExpression.getText(sourceFile).replace(/\s+/g, '')
          : '?';
        return base ? `${base}[${suffix}]` : null;
      }
      return node.getText(sourceFile).replace(/\s+/g, '');
    }

    function collect(
      node,
      hookBody,
      activeHelpers = new Set(),
      environment = new Map(),
    ) {
      const skippedControlFlow = (
        node !== hookBody
        && (
          isFunctionNode(node)
          || ts.isClassDeclaration(node)
          || ts.isClassExpression(node)
          || ts.isIfStatement(node)
          || ts.isConditionalExpression(node)
          || ts.isForStatement(node)
          || ts.isForInStatement(node)
          || ts.isForOfStatement(node)
          || ts.isWhileStatement(node)
          || ts.isDoStatement(node)
          || ts.isSwitchStatement(node)
          || ts.isTryStatement(node)
          || (
            ts.isBinaryExpression(node)
            && [
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
            ].includes(node.operatorToken.kind)
          )
        )
      );
      if (skippedControlFlow) {
        if (
          isFunctionNode(node)
          || ts.isClassDeclaration(node)
          || ts.isClassExpression(node)
        ) return;
        function reportUnsafeSkippedCall(candidate) {
          if (
            candidate !== node
            && (isFunctionNode(candidate)
              || ts.isClassDeclaration(candidate)
              || ts.isClassExpression(candidate))
          ) return;
          if (ts.isCallExpression(candidate)) {
            const nestedHelper = ts.isIdentifier(candidate.expression)
              ? (
                resolveFunctionIdentifier(candidate.expression)
                ?? resolveCallableParameter(candidate.expression, environment)
              )
              : resolvePropertyHelper(candidate, environment);
            if (nestedHelper?.body && activeHelpers.has(nestedHelper)) {
              reportHookIssue(
                candidate,
                'recursive hook helper call cannot be analyzed safely',
              );
            } else if (
              !nestedHelper
              && unresolvedLocalComputedHelper(candidate, environment)
            ) {
              reportHookIssue(
                candidate,
                'computed hook helper call cannot be analyzed safely',
              );
            }
          }
          ts.forEachChild(candidate, reportUnsafeSkippedCall);
        }
        reportUnsafeSkippedCall(node);
        return;
      }
      const guaranteed = !hasPotentialAbruptExitBefore(hookBody, node);
      if (guaranteed && ts.isCallExpression(node)) {
        const mappedCallee = mappedHookText(node.expression, environment);
        if (mappedCallee === 'vi.clearAllMocks') summary.usesClearAllMocks = true;
        if (mappedCallee === 'vi.resetAllMocks') summary.resetsAllMocks = true;
        if (mappedCallee === 'vi.restoreAllMocks') summary.restoresAllMocks = true;
        const helper = ts.isIdentifier(node.expression)
          ? (
            resolveFunctionIdentifier(node.expression)
            ?? resolveCallableParameter(node.expression, environment)
          )
          : resolvePropertyHelper(node, environment);
        if (helper?.body && activeHelpers.has(helper)) {
          reportHookIssue(node, 'recursive hook helper call cannot be analyzed safely');
        } else if (helper?.body) {
          const nextHelpers = new Set(activeHelpers);
          nextHelpers.add(helper);
          const nextEnvironment = new Map(environment);
          for (const [parameter, argument] of (
            helperCapturedEnvironments.get(helper) ?? new Map()
          )) nextEnvironment.set(parameter, argument);
          for (let index = 0; index < helper.parameters.length; index += 1) {
            const parameter = helper.parameters[index];
            const supplied = node.arguments[index];
            const definitelyUndefined = !supplied
              || isSemanticallyUndefined(supplied, environment);
            const usesDefault = !supplied
              || !isDefinitelyNonUndefinedExpression(supplied, environment);
            const argument = definitelyUndefined ? parameter.initializer : supplied;
            nextEnvironment.set(parameter, {
              expression: argument ?? null,
              environment: definitelyUndefined ? nextEnvironment : environment,
              usesDefault,
              definitelyUndefined: definitelyUndefined && !parameter.initializer,
            });
          }
          collect(helper.body, helper.body, nextHelpers, nextEnvironment);
        } else if (unresolvedLocalComputedHelper(node, environment)) {
          reportHookIssue(node, 'computed hook helper call cannot be analyzed safely');
        }
      }
      if (guaranteed && isNamedCall(node, new Set(['clearAllMocks']))) {
        summary.usesClearAllMocks = true;
      }
      if (guaranteed && isNamedCall(node, new Set(['resetAllMocks']))) {
        summary.resetsAllMocks = true;
      }
      if (guaranteed && isNamedCall(node, new Set(['restoreAllMocks']))) {
        summary.restoresAllMocks = true;
      }
      if (
        ts.isCallExpression(node)
        && (
          ts.isPropertyAccessExpression(node.expression)
          || ts.isElementAccessExpression(node.expression)
        )
      ) {
        const method = memberName(node.expression);
        const receiver = unwrap(node.expression.expression);
        const key = mappedHookText(receiver, environment);
        if (guaranteed && key && durableMockMethods.has(method)) summary.rearmed.add(key);
        if (guaranteed && key && resetMockMethods.has(method)) summary.reset.add(key);
      }
      if (
        guaranteed
        &&
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = unwrap(node.left);
        if (ts.isIdentifier(target)) {
          if (!parameterDeclarationFor(target)) {
            summary.refreshedRoots.add(target.text);
          }
        } else {
          const key = mappedHookText(target, environment);
          if (key) summary.refreshedKeys.add(key);
        }
      }
      ts.forEachChild(
        node,
        (child) => collect(child, hookBody, activeHelpers, environment),
      );
    }
    for (const hook of hooks) {
      if (hook.directMethod === 'clearAllMocks') summary.usesClearAllMocks = true;
      if (hook.directMethod === 'resetAllMocks') summary.resetsAllMocks = true;
      if (hook.directMethod === 'restoreAllMocks') summary.restoresAllMocks = true;
      if (hook.callback) collect(hook.callback.body, hook.callback.body);
    }
    return summary;
  }

  function protectionFor(test, hooks) {
    return summarizeHooks(hooks.filter((hook) => hookApplies(hook, test)));
  }

  function isProtectedBefore(info, key, root) {
    return info.before.resetsAllMocks
      || info.before.rearmed.has(key)
      || info.before.reset.has(key)
      || info.before.refreshedRoots.has(root)
      || info.before.refreshedKeys.has(key);
  }

  function isResetAfter(info, key) {
    return info.after.resetsAllMocks || info.after.reset.has(key);
  }

  const testInfos = [];
  for (const test of testCallbacks) {
    const { callback } = test;
    const parameterNames = new Set();
    for (const parameter of callback.parameters) {
      collectBindingNames(parameter.name, parameterNames);
    }
    const expectations = [];
    const earlyReturns = [];
    const overrides = [];
    const spyBindings = new Map();
    const spyAssignments = [];
    const aliasAssignments = [];
    const restoredSpies = new Map();
    const finallyRestoreAll = [];
    const collectedHelperBindings = new Set();

    function collectSpyBindings(node) {
      if (
        node !== callback.body
        && (isFunctionNode(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      ) return;
      if (
        ts.isVariableDeclaration(node)
        && node.initializer
      ) {
        if (ts.isIdentifier(node.name)) {
          const spy = spyTargetFromInitializer(node.initializer, sourceFile);
          if (spy) spyBindings.set(node, spy);
        }
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrap(node.left))
      ) {
        aliasAssignments.push({
          expression: node.right,
          identifier: unwrap(node.left),
          node,
          position: node.getStart(sourceFile),
        });
        const spy = spyTargetFromInitializer(node.right, sourceFile);
        if (spy) {
          spyAssignments.push({
            identifier: unwrap(node.left),
            position: node.getStart(sourceFile),
            spy,
          });
        }
      }
      ts.forEachChild(node, collectSpyBindings);
    }
    collectSpyBindings(callback.body);

    function resolveVariableDeclaration(identifier) {
      let current = identifier.parent;
      while (current && current !== callback) {
        if (ts.isBlock(current)) {
          for (const statement of current.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
              if (!bindingContains(declaration.name, identifier.text)) continue;
              return declaration;
            }
          }
        }
        current = current.parent;
      }
      return null;
    }

    function resolveSpyBinding(identifier) {
      const declaration = resolveVariableDeclaration(identifier);
      if (!declaration) return null;
      let resolved = spyBindings.get(declaration) ?? null;
      let latestPosition = declaration.getStart(sourceFile);
      for (const assignment of spyAssignments) {
        if (
          assignment.position < identifier.getStart(sourceFile)
          && assignment.position > latestPosition
          && resolveVariableDeclaration(assignment.identifier) === declaration
        ) {
          resolved = assignment.spy;
          latestPosition = assignment.position;
        }
      }
      return resolved;
    }

    function bindingPath(name, target, path = []) {
      if (ts.isIdentifier(name)) return name.text === target ? path : null;
      if (ts.isObjectBindingPattern(name)) {
        for (const element of name.elements) {
          const property = element.propertyName ?? element.name;
          const propertyText = ts.isIdentifier(property) || ts.isStringLiteral(property)
            ? property.text
            : property.getText(sourceFile).replace(/\s+/g, '');
          const result = bindingPath(element.name, target, [...path, `.${propertyText}`]);
          if (result) return result;
        }
      }
      if (ts.isArrayBindingPattern(name)) {
        for (let index = 0; index < name.elements.length; index += 1) {
          const element = name.elements[index];
          if (!ts.isBindingElement(element)) continue;
          const result = bindingPath(element.name, target, [...path, `[${index}]`]);
          if (result) return result;
        }
      }
      return null;
    }

    function bindingValueExpression(name, target, expression, environment) {
      if (ts.isIdentifier(name)) {
        return name.text === target ? { expression, environment } : null;
      }
      if (ts.isObjectBindingPattern(name)) {
        const resolvedObject = resolveObjectLiteralInfo(
          expression,
          new Set(),
          environment,
        );
        if (!resolvedObject) return null;
        for (const element of name.elements) {
          if (element.dotDotDotToken) {
            if (bindingContains(element.name, target)) {
              return {
                expression,
                environment,
                restBinding: true,
              };
            }
            continue;
          }
          const property = element.propertyName ?? element.name;
          let propertyText = (
            ts.isIdentifier(property)
            || ts.isStringLiteral(property)
            || ts.isNumericLiteral(property)
          ) ? property.text : null;
          if (ts.isComputedPropertyName(property)) {
            const computed = unwrap(property.expression);
            if (ts.isStringLiteral(computed) || ts.isNumericLiteral(computed)) {
              propertyText = computed.text;
            } else if (ts.isIdentifier(computed)) {
              const declaration = resolveLexicalVariableDeclaration(computed);
              const initializer = declaration?.initializer
                ? unwrap(declaration.initializer)
                : null;
              if (
                declaration
                && ts.isVariableDeclarationList(declaration.parent)
                && (declaration.parent.flags & ts.NodeFlags.Const)
                &&
                initializer
                && (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer))
              ) propertyText = initializer.text;
            }
          }
          if (propertyText === null) continue;
          const value = objectPropertyValue(
            resolvedObject.literal,
            propertyText,
            resolvedObject.environment,
          );
          const selected = (
            !value
            || isSemanticallyUndefined(value.expression, value.environment)
          ) && element.initializer
            ? {
              expression: element.initializer,
              environment: resolvedObject.environment,
            }
            : value;
          if (!selected) continue;
          const resolved = bindingValueExpression(
            element.name,
            target,
            selected.expression,
            selected.environment,
          );
          if (resolved) return resolved;
        }
      }
      if (ts.isArrayBindingPattern(name)) {
        const resolvedArray = resolveArrayLiteralInfo(
          expression,
          new Set(),
          environment,
        );
        if (!resolvedArray) return null;
        for (let index = 0; index < name.elements.length; index += 1) {
          const element = name.elements[index];
          if (!ts.isBindingElement(element)) continue;
          if (element.dotDotDotToken) {
            if (bindingContains(element.name, target)) {
              return {
                expression,
                environment,
                restBinding: true,
              };
            }
            continue;
          }
          const value = arrayElementValue(
            resolvedArray.literal,
            index,
            resolvedArray.environment,
          );
          const selected = (
            !value
            || isSemanticallyUndefined(value.expression, value.environment)
          ) && element.initializer
            ? {
              expression: element.initializer,
              environment: resolvedArray.environment,
            }
            : value;
          if (!selected) continue;
          const resolved = bindingValueExpression(
            element.name,
            target,
            selected.expression,
            selected.environment,
          );
          if (resolved) return resolved;
        }
      }
      return null;
    }

    function bindingDefaultExpressions(name, target, defaults = []) {
      if (ts.isIdentifier(name)) return defaults;
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (!bindingContains(element.name, target)) continue;
        bindingDefaultExpressions(element.name, target, defaults);
        if (element.initializer) defaults.push(element.initializer);
      }
      return defaults;
    }

    function restBindingInfo(name, target) {
      if (ts.isIdentifier(name)) return null;
      for (let index = 0; index < name.elements.length; index += 1) {
        const element = name.elements[index];
        if (!ts.isBindingElement(element)) continue;
        if (element.dotDotDotToken && bindingContains(element.name, target)) {
          return {
            kind: ts.isObjectBindingPattern(name) ? 'object' : 'array',
            startIndex: index,
          };
        }
        if (bindingContains(element.name, target)) {
          const nested = restBindingInfo(element.name, target);
          if (nested) return nested;
        }
      }
      return null;
    }

    function resolveRestMember(expression, environment) {
      const member = unwrap(expression);
      if (
        !ts.isPropertyAccessExpression(member)
        && !ts.isElementAccessExpression(member)
      ) return null;
      const base = unwrap(member.expression);
      if (!ts.isIdentifier(base)) return null;
      const parameter = parameterDeclarationFor(base);
      const argument = parameter ? environment.get(parameter) : null;
      if (!parameter || !argument?.expression) return null;
      const rest = parameter.dotDotDotToken
        ? { kind: 'array', startIndex: 0 }
        : restBindingInfo(parameter.name, base.text);
      if (!rest) return null;
      const propertyName = ts.isPropertyAccessExpression(member)
        ? member.name.text
        : (
          member.argumentExpression
          && (
            ts.isStringLiteral(member.argumentExpression)
            || ts.isNumericLiteral(member.argumentExpression)
          )
            ? member.argumentExpression.text
            : null
        );
      if (propertyName === null) return { unresolved: true };
      if (rest.kind === 'object') {
        const objectInfo = resolveObjectLiteralInfo(
          argument.expression,
          new Set(),
          argument.environment,
        );
        if (!objectInfo) return { unresolved: true };
        return objectPropertyValue(
          objectInfo.literal,
          propertyName,
          objectInfo.environment,
        ) ?? { unresolved: true };
      }
      const arrayInfo = resolveArrayLiteralInfo(
        argument.expression,
        new Set(),
        argument.environment,
      );
      const index = Number(propertyName);
      if (!arrayInfo || !Number.isInteger(index)) return { unresolved: true };
      return arrayElementValue(
        arrayInfo.literal,
        rest.startIndex + index,
        arrayInfo.environment,
      ) ?? { unresolved: true };
    }

    function statementDominates(earlierNode, laterNode) {
      let block = laterNode.parent;
      while (block && block !== callback) {
        if (ts.isBlock(block)) {
          let earlierStatement = earlierNode;
          while (earlierStatement.parent && earlierStatement.parent !== block) {
            earlierStatement = earlierStatement.parent;
          }
          let laterStatement = laterNode;
          while (laterStatement.parent && laterStatement.parent !== block) {
            laterStatement = laterStatement.parent;
          }
          if (
            earlierStatement.parent === block
            && laterStatement.parent === block
            && ts.isExpressionStatement(earlierStatement)
          ) {
            let expressionNode = earlierNode;
            let conditional = false;
            while (expressionNode.parent && expressionNode.parent !== earlierStatement) {
              const parent = expressionNode.parent;
              if (
                ts.isConditionalExpression(parent)
                || (
                  ts.isBinaryExpression(parent)
                  && [
                    ts.SyntaxKind.AmpersandAmpersandToken,
                    ts.SyntaxKind.BarBarToken,
                    ts.SyntaxKind.QuestionQuestionToken,
                  ].includes(parent.operatorToken.kind)
                )
                || (
                  (ts.isCallExpression(parent)
                    || ts.isPropertyAccessExpression(parent)
                    || ts.isElementAccessExpression(parent))
                  && parent.questionDotToken
                )
              ) {
                conditional = true;
                break;
              }
              expressionNode = parent;
            }
            if (conditional) return false;
            const earlierIndex = block.statements.indexOf(earlierStatement);
            const laterIndex = block.statements.indexOf(laterStatement);
            if (earlierIndex >= 0 && earlierIndex < laterIndex) return true;
          }
        }
        block = block.parent;
      }
      return false;
    }

    function uniqueReferences(references) {
      const seenKeys = new Set();
      return references.filter((reference) => {
        const identity = `${reference.root}:${reference.key}`;
        if (seenKeys.has(identity)) return false;
        seenKeys.add(identity);
        return true;
      });
    }

    function resolveSharedReferences(
      expression,
      atPosition,
      seen = new Set(),
      environment = new Map(),
    ) {
      let node = unwrap(expression);
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'vi'
        && node.expression.name.text === 'mocked'
        && node.arguments[0]
      ) node = unwrap(node.arguments[0]);

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const restMember = resolveRestMember(node, environment);
        if (restMember && !restMember.unresolved) {
          return resolveSharedReferences(
            restMember.expression,
            atPosition,
            seen,
            restMember.environment,
          );
        }
        const bases = resolveSharedReferences(node.expression, atPosition, seen, environment);
        const suffix = ts.isPropertyAccessExpression(node)
          ? `.${node.name.text}`
          : `[${node.argumentExpression?.getText(sourceFile).replace(/\s+/g, '') ?? '?'}]`;
        return bases.map((base) => ({
          key: `${base.key}${suffix}`,
          root: base.root,
        }));
      }

      if (ts.isConditionalExpression(node)) {
        return uniqueReferences([
          ...resolveSharedReferences(node.whenTrue, atPosition, seen, environment),
          ...resolveSharedReferences(node.whenFalse, atPosition, seen, environment),
        ]);
      }

      if (
        ts.isBinaryExpression(node)
        && [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      ) {
        return uniqueReferences([
          ...resolveSharedReferences(node.left, atPosition, seen, environment),
          ...resolveSharedReferences(node.right, atPosition, seen, environment),
        ]);
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const factory = resolveFunctionIdentifier(node.expression);
        const returns = factory ? guaranteedReturnExpressions(factory) : null;
        if (factory && returns && !seen.has(factory)) {
          const nextSeen = new Set(seen);
          nextSeen.add(factory);
          const factoryEnvironment = callEnvironment(factory, node, environment);
          return uniqueReferences(returns.flatMap((returned) => (
            resolveSharedReferences(
              returned,
              atPosition,
              nextSeen,
              factoryEnvironment,
            )
          )));
        }
      }

      if (!ts.isIdentifier(node)) return [];
      const parameter = parameterDeclarationFor(node);
      const argument = parameter ? environment.get(parameter) : null;
      if (parameter) {
        if (!argument) return [];
        const mappedValue = argument.expression
          ? bindingValueExpression(
            parameter.name,
            node.text,
            argument.expression,
            argument.environment,
          )
          : null;
        const bases = mappedValue
          ? resolveSharedReferences(
            mappedValue.expression,
            argument.position,
            seen,
            mappedValue.environment,
          )
          : (
            argument.expression && ts.isIdentifier(parameter.name)
              ? resolveSharedReferences(
                argument.expression,
                argument.position,
                seen,
                argument.environment,
              )
              : []
          );
        const path = bindingPath(parameter.name, node.text);
        const references = mappedValue
          ? bases
          : path
          ? bases.map((base) => ({
            key: `${base.key}${path.join('')}`,
            root: base.root,
          }))
          : [];
        if (parameter.initializer && argument.usesDefault) {
          references.push(...resolveSharedReferences(
            parameter.initializer,
            argument.position,
            seen,
            argument.environment,
          ));
        }
        const fallbacks = bindingDefaultExpressions(parameter.name, node.text);
        if (
          fallbacks.length > 0
          && (
            !mappedValue
            || !isDefinitelyNonUndefinedExpression(
              mappedValue.expression,
              mappedValue.environment,
            )
          )
        ) {
          for (const fallback of fallbacks) {
            references.push(...resolveSharedReferences(
              fallback,
              argument.position,
              seen,
              argument.environment,
            ));
          }
        }
        return uniqueReferences(references);
      }
      const declaration = resolveVariableDeclaration(node);
      if (!declaration) {
        return [{ key: node.text, root: node.text }];
      }
      if (seen.has(declaration)) return [];
      const nextSeen = new Set(seen);
      nextSeen.add(declaration);

      let candidates = declaration.initializer
        ? [{ expression: declaration.initializer, position: declaration.getStart(sourceFile) }]
        : [];
      const assignments = aliasAssignments
        .filter((assignment) => (
          assignment.position < atPosition
          && resolveVariableDeclaration(assignment.identifier) === declaration
        ))
        .sort((left, right) => left.position - right.position);
      for (const assignment of assignments) {
        const candidate = {
          expression: assignment.expression,
          position: assignment.position,
        };
        if (statementDominates(assignment.node, node)) candidates = [candidate];
        else candidates.push(candidate);
      }
      const path = bindingPath(declaration.name, node.text);
      if (!path) return [];
      const references = [];
      for (const candidate of candidates) {
        const bases = resolveSharedReferences(
          candidate.expression,
          candidate.position,
          nextSeen,
          environment,
        );
        for (const base of bases) {
          references.push({
            key: `${base.key}${path.join('')}`,
            root: base.root,
          });
        }
      }
      const fallbacks = bindingDefaultExpressions(declaration.name, node.text);
      for (const fallback of fallbacks) {
        references.push(...resolveSharedReferences(
          fallback,
          atPosition,
          nextSeen,
          environment,
        ));
      }
      return uniqueReferences(references);
    }

    function normalizeSpies(spy, atPosition, environment) {
      if (!spy) return [];
      return resolveSharedReferences(spy.target, atPosition, new Set(), environment)
        .map((target) => ({
        ...spy,
        key: `${target.key}${spy.propertySuffix}`,
        root: target.root,
        }));
    }

    function guaranteedFinally(node) {
      let current = node;
      let finallyBlock = null;
      let tryStatement = null;
      while (current && current !== callback) {
        const parent = current.parent;
        if (!parent) return false;
        if (
          ts.isBlock(current)
          && ts.isTryStatement(parent)
          && parent.finallyBlock === current
        ) {
          finallyBlock = current;
          tryStatement = parent;
          break;
        }
        current = parent;
      }
      if (!finallyBlock || !tryStatement) return null;
      let directStatement = node;
      while (directStatement.parent && directStatement.parent !== finallyBlock) {
        directStatement = directStatement.parent;
      }
      return finallyBlock.statements[0] === directStatement
        && ts.isExpressionStatement(directStatement)
        ? tryStatement
        : null;
    }

    function inspect(
      node,
      activeHelpers = new Set(),
      recordExpectations = true,
      environment = new Map(),
    ) {
      if (
        node !== callback.body
        && (isFunctionNode(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      ) return;
      if (ts.isCallExpression(node)) {
        const helper = ts.isIdentifier(node.expression)
          && node.expression.text !== 'expect'
          ? (
            resolveFunctionIdentifier(node.expression)
            ?? resolveCallableParameter(node.expression, environment)
          )
          : resolvePropertyHelper(node, environment);
        function projectValuePath(value, path) {
          let current = value;
          for (const segment of path) {
            const objectInfo = resolveObjectLiteralInfo(
              current.expression,
              new Set(),
              current.environment,
            );
            if (objectInfo) {
              const property = objectPropertyValue(
                objectInfo.literal,
                String(segment),
                objectInfo.environment,
              );
              if (!property) return null;
              current = property;
              continue;
            }
            const arrayInfo = resolveArrayLiteralInfo(
              current.expression,
              new Set(),
              current.environment,
            );
            const index = Number(segment);
            if (!arrayInfo || !Number.isInteger(index)) return null;
            const element = arrayElementValue(
              arrayInfo.literal,
              index,
              arrayInfo.environment,
            );
            if (!element) return null;
            current = element;
          }
          return current;
        }
        function helperMutatedParameterTargets(
          targetHelper,
          seenHelpers = new Set(),
          analysisEnvironment = new Map(),
        ) {
          if (seenHelpers.has(targetHelper)) return [];
          const nextSeenHelpers = new Set(seenHelpers);
          nextSeenHelpers.add(targetHelper);
          const parameterBindings = new Map();
          targetHelper.parameters.forEach((parameter, index) => {
            const names = new Set();
            collectBindingNames(parameter.name, names);
            for (const name of names) {
              parameterBindings.set(name, { index, target: name });
            }
          });
          function originParameterTarget(expression, seenDeclarations = new Set()) {
            let candidate = unwrap(expression);
            const path = [];
            while (
              ts.isPropertyAccessExpression(candidate)
              || ts.isElementAccessExpression(candidate)
            ) {
              const segment = ts.isPropertyAccessExpression(candidate)
                ? candidate.name.text
                : (
                  candidate.argumentExpression
                  && (
                    ts.isStringLiteral(candidate.argumentExpression)
                    || ts.isNumericLiteral(candidate.argumentExpression)
                  )
                    ? candidate.argumentExpression.text
                    : null
                );
              if (segment === null) return null;
              path.unshift(segment);
              candidate = unwrap(candidate.expression);
            }
            if (!ts.isIdentifier(candidate)) return null;
            if (parameterBindings.has(candidate.text)) {
              return { ...parameterBindings.get(candidate.text), path };
            }
            const declaration = resolveLexicalVariableDeclaration(candidate);
            if (
              !declaration?.initializer
              || seenDeclarations.has(declaration)
              || nearestFunction(declaration) !== targetHelper
            ) return null;
            const nextSeenDeclarations = new Set(seenDeclarations);
            nextSeenDeclarations.add(declaration);
            const origin = originParameterTarget(
              declaration.initializer,
              nextSeenDeclarations,
            );
            return origin ? { ...origin, path: [...origin.path, ...path] } : null;
          }
          const mutated = new Map();
          function record(target) {
            if (target) {
              mutated.set(
                `${target.index}:${target.target}:${target.path.join('.')}`,
                target,
              );
            }
          }
          function visit(candidate) {
            if (
              candidate !== targetHelper.body
              && (isFunctionNode(candidate)
                || ts.isClassDeclaration(candidate)
                || ts.isClassExpression(candidate))
            ) return;
            if (
              ts.isCallExpression(candidate)
              && (
                ts.isPropertyAccessExpression(candidate.expression)
                || ts.isElementAccessExpression(candidate.expression)
              )
              && persistentMockMethods.has(memberName(candidate.expression))
            ) {
              record(originParameterTarget(candidate.expression.expression));
            }
            if (ts.isCallExpression(candidate)) {
              const calledHelper = ts.isIdentifier(candidate.expression)
                ? resolveFunctionIdentifier(candidate.expression)
                : resolvePropertyHelper(candidate, analysisEnvironment);
              if (calledHelper?.body && !nextSeenHelpers.has(calledHelper)) {
                const calledMutations = helperMutatedParameterTargets(
                  calledHelper,
                  nextSeenHelpers,
                  callEnvironment(calledHelper, candidate, analysisEnvironment),
                );
                for (const calledMutation of calledMutations) {
                  const calledParameter = calledHelper.parameters[calledMutation.index];
                  const supplied = candidate.arguments[calledMutation.index]
                    ?? calledParameter?.initializer;
                  if (!supplied) continue;
                  const projected = bindingValueExpression(
                    calledParameter.name,
                    calledMutation.target,
                    supplied,
                    analysisEnvironment,
                  );
                  const leaf = projectValuePath(
                    projected ?? { expression: supplied, environment: analysisEnvironment },
                    calledMutation.path,
                  );
                  record(originParameterTarget(leaf?.expression ?? supplied));
                }
              }
            }
            ts.forEachChild(candidate, visit);
          }
          visit(targetHelper.body);
          return [...mutated.values()];
        }
        function isDefinitelyTestLocalMock(
          expression,
          currentEnvironment,
          seen = new Set(),
          allocationFactory = null,
        ) {
          const candidate = unwrap(expression);
          if (
            ts.isCallExpression(candidate)
            && ts.isPropertyAccessExpression(candidate.expression)
            && ts.isIdentifier(candidate.expression.expression)
            && candidate.expression.expression.text === 'vi'
            && candidate.expression.name.text === 'fn'
          ) {
            const owner = nearestFunction(candidate);
            return owner === callback
              || owner === allocationFactory
              || activeHelpers.has(owner);
          }
          if (ts.isConditionalExpression(candidate)) {
            return isDefinitelyTestLocalMock(
              candidate.whenTrue,
              currentEnvironment,
              seen,
              allocationFactory,
            )
              && isDefinitelyTestLocalMock(
                candidate.whenFalse,
                currentEnvironment,
                seen,
                allocationFactory,
              );
          }
          if (
            ts.isPropertyAccessExpression(candidate)
            || ts.isElementAccessExpression(candidate)
          ) {
            let root = candidate;
            while (
              ts.isPropertyAccessExpression(root)
              || ts.isElementAccessExpression(root)
            ) root = unwrap(root.expression);
            if (!ts.isIdentifier(root) || !resolveVariableDeclaration(root)) return false;
            const propertyName = ts.isPropertyAccessExpression(candidate)
              ? candidate.name.text
              : (
                candidate.argumentExpression
                && (
                  ts.isStringLiteral(candidate.argumentExpression)
                  || ts.isNumericLiteral(candidate.argumentExpression)
                )
                  ? candidate.argumentExpression.text
                  : null
              );
            if (propertyName === null) return false;
            const objectInfo = resolveObjectLiteralInfo(
              candidate.expression,
              new Set(),
              currentEnvironment,
            );
            if (objectInfo) {
              const value = objectPropertyValue(
                objectInfo.literal,
                propertyName,
                objectInfo.environment,
              );
              return value
                ? isDefinitelyTestLocalMock(
                  value.expression,
                  value.environment,
                  seen,
                  allocationFactory,
                )
                : false;
            }
            const arrayInfo = resolveArrayLiteralInfo(
              candidate.expression,
              new Set(),
              currentEnvironment,
            );
            const index = Number(propertyName);
            const value = arrayInfo && Number.isInteger(index)
              ? arrayElementValue(
                arrayInfo.literal,
                index,
                arrayInfo.environment,
              )
              : null;
            return value
              ? isDefinitelyTestLocalMock(
                value.expression,
                value.environment,
                seen,
                allocationFactory,
              )
              : false;
          }
          if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)) {
            const callOwner = nearestFunction(candidate);
            if (callOwner !== callback && !activeHelpers.has(callOwner)) return false;
            const factory = resolveFunctionIdentifier(candidate.expression);
            const returns = factory ? guaranteedReturnExpressions(factory) : null;
            if (!factory || !returns || seen.has(factory)) return false;
            const nextSeen = new Set(seen);
            nextSeen.add(factory);
            const factoryEnvironment = callEnvironment(
              factory,
              candidate,
              currentEnvironment,
            );
            return returns.every((returned) => (
              isDefinitelyTestLocalMock(
                returned,
                factoryEnvironment,
                nextSeen,
                factory,
              )
            ));
          }
          if (!ts.isIdentifier(candidate)) return false;
          const parameter = parameterDeclarationFor(candidate);
          const argument = parameter ? currentEnvironment.get(parameter) : null;
          if (argument?.expression && !seen.has(parameter)) {
            const nextSeen = new Set(seen);
            nextSeen.add(parameter);
            return isDefinitelyTestLocalMock(
              argument.expression,
              argument.environment,
              nextSeen,
              allocationFactory,
            );
          }
          const declaration = resolveVariableDeclaration(candidate);
          if (!declaration?.initializer || seen.has(declaration)) return false;
          const nextSeen = new Set(seen);
          nextSeen.add(declaration);
          return isDefinitelyTestLocalMock(
            declaration.initializer,
            currentEnvironment,
            nextSeen,
            allocationFactory,
          );
        }
        function bindingHasUnresolvedComputedName(name) {
          if (ts.isIdentifier(name)) return false;
          return name.elements.some((element) => (
            ts.isBindingElement(element)
            && (
              (
                element.propertyName
                && ts.isComputedPropertyName(element.propertyName)
                && resolvedPropertyName(element.propertyName) === null
              )
              || bindingHasUnresolvedComputedName(element.name)
            )
          ));
        }
        if (
          helper?.body
          && helper.parameters.some((parameter) => (
            bindingHasUnresolvedComputedName(parameter.name)
          ))
          && helperMutatedParameterTargets(helper, new Set(), environment).length > 0
        ) {
          issues.push({
            line: lineOf(sourceFile, node),
            message: 'computed binding key cannot be analyzed safely',
          });
        }
        const recursiveMutatedTargets = helper && activeHelpers.has(helper)
          ? helperMutatedParameterTargets(helper, new Set(), environment)
          : [];
        const recursiveCanChangeSharedMapping = helper
          && activeHelpers.has(helper)
          && recursiveMutatedTargets.some(({ index, target, path }) => {
            const parameter = helper.parameters[index];
            const supplied = node.arguments[index] ?? parameter?.initializer;
            if (!supplied) return true;
            const projected = bindingValueExpression(
              parameter.name,
              target,
              supplied,
              environment,
            );
            const leaf = projected ? projectValuePath(projected, path) : null;
            if (!leaf) return true;
            if (
              resolveSharedReferences(
                leaf.expression,
                node.getStart(sourceFile),
                new Set(),
                leaf.environment,
              ).length > 0
            ) return true;
            return !isDefinitelyTestLocalMock(leaf.expression, leaf.environment);
          });
        if (recursiveCanChangeSharedMapping) {
          issues.push({
            line: lineOf(sourceFile, node),
            message: 'recursive helper call cannot be analyzed safely',
          });
        } else if (
          helper
          && helper !== callback
          && helper.body
          && !activeHelpers.has(helper)
        ) {
          const nextHelpers = new Set(activeHelpers);
          nextHelpers.add(helper);
          if (!collectedHelperBindings.has(helper)) {
            collectedHelperBindings.add(helper);
            collectSpyBindings(helper.body);
          }
          const nextEnvironment = new Map(environment);
          for (const [parameter, argument] of (
            helperCapturedEnvironments.get(helper) ?? new Map()
          )) nextEnvironment.set(parameter, argument);
          for (let index = 0; index < helper.parameters.length; index += 1) {
            const parameter = helper.parameters[index];
            const supplied = node.arguments[index];
            const definitelyUndefined = !supplied
              || isSemanticallyUndefined(supplied, environment);
            const usesDefault = !supplied
              || !isDefinitelyNonUndefinedExpression(supplied, environment);
            const argument = definitelyUndefined ? parameter.initializer : supplied;
            nextEnvironment.set(parameter, {
              expression: argument ?? null,
              position: node.getStart(sourceFile),
              environment: definitelyUndefined ? nextEnvironment : environment,
              usesDefault,
              definitelyUndefined: definitelyUndefined && !parameter.initializer,
            });
          }
          inspect(helper.body, nextHelpers, false, nextEnvironment);
        } else if (!helper && unresolvedLocalComputedHelper(node, environment)) {
          issues.push({
            line: lineOf(sourceFile, node),
            message: 'computed helper call cannot be analyzed safely',
          });
        }
        if (isNamedCall(node, new Set(['restoreAllMocks']))) {
          const restoringTry = guaranteedFinally(node);
          if (restoringTry) {
            finallyRestoreAll.push({
              position: node.getStart(sourceFile),
              tryStatement: restoringTry,
            });
          }
        }
        if (
          ts.isIdentifier(node.expression)
          && node.expression.text === 'expect'
          && recordExpectations
        ) {
          expectations.push(node);
        }
        if (
          ts.isPropertyAccessExpression(node.expression)
          || ts.isElementAccessExpression(node.expression)
        ) {
          const method = memberName(node.expression);
          const position = node.getStart(sourceFile);
          const directSpies = normalizeSpies(
            spyTarget(node.expression.expression, sourceFile),
            position,
            environment,
          );
          const receiver = unwrap(node.expression.expression);
          const boundSpies = ts.isIdentifier(receiver)
            ? normalizeSpies(resolveSpyBinding(receiver), position, environment)
            : [];
          const mockReferences = resolveSharedReferences(
            receiver,
            position,
            new Set(),
            environment,
          );
          function receiverUsesUnresolvedRestBinding(
            expression,
            seenDeclarations = new Set(),
          ) {
            const directRest = resolveRestMember(expression, environment);
            if (directRest) return !!directRest.unresolved;
            function dependsOnRest(candidate, seen = new Set()) {
              const current = unwrap(candidate);
              if (
                ts.isPropertyAccessExpression(current)
                || ts.isElementAccessExpression(current)
              ) {
                const propertyName = ts.isPropertyAccessExpression(current)
                  ? current.name.text
                  : (
                    current.argumentExpression
                    && (
                      ts.isStringLiteral(current.argumentExpression)
                      || ts.isNumericLiteral(current.argumentExpression)
                    )
                      ? current.argumentExpression.text
                      : null
                  );
                if (propertyName !== null) {
                  const objectInfo = resolveObjectLiteralInfo(
                    current.expression,
                    new Set(),
                    new Map(),
                  );
                  if (objectInfo) {
                    const value = objectPropertyValue(
                      objectInfo.literal,
                      propertyName,
                      objectInfo.environment,
                    );
                    if (value) return dependsOnRest(value.expression, seen);
                  }
                  const arrayInfo = resolveArrayLiteralInfo(
                    current.expression,
                    new Set(),
                    new Map(),
                  );
                  const index = Number(propertyName);
                  if (arrayInfo && Number.isInteger(index)) {
                    const value = arrayElementValue(
                      arrayInfo.literal,
                      index,
                      arrayInfo.environment,
                    );
                    if (value) return dependsOnRest(value.expression, seen);
                  }
                }
                return dependsOnRest(current.expression, seen);
              }
              if (ts.isObjectLiteralExpression(current)) {
                return current.properties.some((property) => (
                  ts.isSpreadAssignment(property)
                    ? dependsOnRest(property.expression, seen)
                    : ts.isPropertyAssignment(property)
                      ? dependsOnRest(property.initializer, seen)
                      : ts.isShorthandPropertyAssignment(property)
                        ? dependsOnRest(property.name, seen)
                        : false
                ));
              }
              if (ts.isArrayLiteralExpression(current)) {
                return current.elements.some((element) => (
                  ts.isSpreadElement(element)
                    ? dependsOnRest(element.expression, seen)
                    : dependsOnRest(element, seen)
                ));
              }
              if (!ts.isIdentifier(current)) return false;
              const parameter = parameterDeclarationFor(current);
              if (parameter) {
                if (parameter.dotDotDotToken) return true;
                if (restBindingInfo(parameter.name, current.text)) return true;
              }
              const declaration = resolveVariableDeclaration(current);
              if (!declaration?.initializer || seen.has(declaration)) return false;
              const nextSeen = new Set(seen);
              nextSeen.add(declaration);
              return dependsOnRest(declaration.initializer, nextSeen);
            }
            if (dependsOnRest(expression)) return true;
            const selectedMember = unwrap(expression);
            if (
              ts.isPropertyAccessExpression(selectedMember)
              || ts.isElementAccessExpression(selectedMember)
            ) {
              const propertyName = ts.isPropertyAccessExpression(selectedMember)
                ? selectedMember.name.text
                : (
                  selectedMember.argumentExpression
                  && (
                    ts.isStringLiteral(selectedMember.argumentExpression)
                    || ts.isNumericLiteral(selectedMember.argumentExpression)
                  )
                    ? selectedMember.argumentExpression.text
                    : null
                );
              const objectInfo = propertyName !== null
                ? resolveObjectLiteralInfo(
                  selectedMember.expression,
                  new Set(),
                  new Map(),
                )
                : null;
              const selected = objectInfo && propertyName !== null
                ? objectPropertyValue(
                  objectInfo.literal,
                  propertyName,
                  objectInfo.environment,
                )
                : null;
              if (selected && !dependsOnRest(selected.expression)) return false;
              const arrayInfo = propertyName !== null
                ? resolveArrayLiteralInfo(
                  selectedMember.expression,
                  new Set(),
                  new Map(),
                )
                : null;
              const index = Number(propertyName);
              const selectedElement = arrayInfo && Number.isInteger(index)
                ? arrayElementValue(
                  arrayInfo.literal,
                  index,
                  arrayInfo.environment,
                )
                : null;
              if (selectedElement && !dependsOnRest(selectedElement.expression)) return false;
            }
            const rootName = callRootName(expression);
            if (!rootName) return false;
            let rootNode = unwrap(expression);
            while (
              ts.isPropertyAccessExpression(rootNode)
              || ts.isElementAccessExpression(rootNode)
            ) rootNode = unwrap(rootNode.expression);
            if (!ts.isIdentifier(rootNode)) return false;
            const parameter = parameterDeclarationFor(rootNode);
            if (parameter) {
              if (parameter.dotDotDotToken && bindingContains(parameter.name, rootName)) {
                return true;
              }
              function containsRest(name) {
                if (ts.isIdentifier(name)) return false;
                return name.elements.some((element) => (
                  ts.isBindingElement(element)
                  && bindingContains(element.name, rootName)
                  && (element.dotDotDotToken || containsRest(element.name))
                ));
              }
              if (containsRest(parameter.name)) return true;
            }
            const declaration = resolveVariableDeclaration(rootNode);
            if (!declaration?.initializer || seenDeclarations.has(declaration)) return false;
            const nextSeen = new Set(seenDeclarations);
            nextSeen.add(declaration);
            return receiverUsesUnresolvedRestBinding(
              declaration.initializer,
              nextSeen,
            );
          }
          if (
            persistentMockMethods.has(method)
            && receiverUsesUnresolvedRestBinding(receiver)
          ) {
            issues.push({
              line: lineOf(sourceFile, node),
              message: 'destructured rest mock mutation cannot be analyzed safely',
            });
          }
          if (method === null && mockReferences.length > 0) {
            issues.push({
              line: lineOf(sourceFile, node),
              message: 'computed shared method call cannot be analyzed safely',
            });
          }
          const spies = directSpies.length > 0 ? directSpies : boundSpies;
          const restoringTry = boundSpies.length > 0 && method === 'mockRestore'
            ? guaranteedFinally(node)
            : null;
          if (
            boundSpies.length > 0
            && method === 'mockRestore'
            && restoringTry
          ) {
            for (const boundSpy of boundSpies) {
              const restorations = restoredSpies.get(boundSpy.key) ?? [];
              restorations.push({
                position: node.getStart(sourceFile),
                tryStatement: restoringTry,
              });
              restoredSpies.set(boundSpy.key, restorations);
            }
          }
          if (spies.length > 0 && persistentMockMethods.has(method)) {
            for (const spy of spies) {
              overrides.push({ ...spy, node, isSpy: true });
            }
          } else if (
            mockReferences.length > 0
            && persistentMockMethods.has(method)
          ) {
            for (const mockReference of mockReferences) {
              overrides.push({ ...mockReference, node, isSpy: false });
            }
          }

          const expectCall = unwrap(node.expression.expression);
          if (
            ts.isCallExpression(expectCall)
            && ts.isIdentifier(expectCall.expression)
            && expectCall.expression.text === 'expect'
            && expectCall.arguments[0]
            && ts.isIdentifier(unwrap(expectCall.arguments[0]))
            && parameterNames.has(unwrap(expectCall.arguments[0]).text)
            && node.arguments[0]
            && ts.isIdentifier(unwrap(node.arguments[0]))
            && parameterNames.has(unwrap(node.arguments[0]).text)
          ) {
            issues.push({
              line: lineOf(sourceFile, node),
              message: 'expectation compares only test-table inputs; assert a system-produced value instead',
            });
          }
        }
      }
      if (
        ts.isReturnStatement(node)
        && nearestFunction(node) === callback
      ) {
        earlyReturns.push(node);
      }
      ts.forEachChild(
        node,
        (child) => inspect(child, activeHelpers, recordExpectations, environment),
      );
    }
    inspect(callback.body);

    function directChildOfBlock(node, block) {
      let current = node;
      while (current.parent && current.parent !== block) {
        if (current === callback) return null;
        current = current.parent;
      }
      return current.parent === block ? current : null;
    }

    function isUnconditionalExpressionPath(node, boundary) {
      let current = node;
      while (current.parent && current.parent !== boundary) {
        const parent = current.parent;
        if (
          ts.isConditionalExpression(parent)
          || (
            ts.isBinaryExpression(parent)
            && [
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
            ].includes(parent.operatorToken.kind)
          )
          || (
            (ts.isCallExpression(parent)
              || ts.isPropertyAccessExpression(parent)
              || ts.isElementAccessExpression(parent))
            && parent.questionDotToken
          )
        ) return false;
        current = parent;
      }
      return current.parent === boundary;
    }

    function expectationDominatesReturn(expectation, returnNode) {
      let current = returnNode.parent;
      while (current && current !== callback) {
        if (ts.isBlock(current)) {
          const returnChild = directChildOfBlock(returnNode, current);
          const expectationChild = directChildOfBlock(expectation, current);
          if (
            returnChild
            && expectationChild
            && ts.isExpressionStatement(expectationChild)
            && isUnconditionalExpressionPath(expectation, expectationChild)
          ) {
            const returnIndex = current.statements.indexOf(returnChild);
            const expectationIndex = current.statements.indexOf(expectationChild);
            if (expectationIndex >= 0 && expectationIndex < returnIndex) return true;
          }
        }
        current = current.parent;
      }
      return false;
    }

    for (const returnNode of earlyReturns) {
      let returnedAssertion = false;
      function findReturnedAssertion(node) {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'expect'
          && isUnconditionalExpressionPath(node, returnNode)
        ) returnedAssertion = true;
        ts.forEachChild(node, findReturnedAssertion);
      }
      if (returnNode.expression) findReturnedAssertion(returnNode.expression);
      if (
        !returnedAssertion
        && !expectations.some((expectation) => expectationDominatesReturn(expectation, returnNode))
      ) {
        issues.push({
          line: lineOf(sourceFile, returnNode),
          message: 'test can return before its first assertion',
        });
      }
    }

    testInfos.push({
      callback,
      overrides,
      restoredSpies,
      finallyRestoreAll,
      before: protectionFor(test, setupCallbacks),
      after: protectionFor(test, teardownCallbacks),
    });
  }

  const reported = new Set();
  function nodeIsWithin(node, ancestor) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  function finallyRestorationCovers(restoration, overrideNode) {
    const tryStatement = restoration.tryStatement;
    if (nodeIsWithin(overrideNode, tryStatement.tryBlock)) return true;
    const block = tryStatement.parent;
    if (!ts.isBlock(block)) return false;
    let overrideStatement = overrideNode;
    while (overrideStatement.parent && overrideStatement.parent !== block) {
      overrideStatement = overrideStatement.parent;
    }
    if (overrideStatement.parent !== block) return false;
    const overrideIndex = block.statements.indexOf(overrideStatement);
    const tryIndex = block.statements.indexOf(tryStatement);
    return overrideIndex >= 0 && tryIndex === overrideIndex + 1;
  }

  for (const info of testInfos) {
    for (const { key, root, node, isSpy } of info.overrides) {
      if (isSpy) {
        const restoredAfterOverride = (info.restoredSpies.get(key) ?? [])
          .some((restoration) => (
            restoration.position > node.getStart(sourceFile)
            && finallyRestorationCovers(restoration, node)
          ))
          || info.finallyRestoreAll.some((restoration) => (
            restoration.position > node.getStart(sourceFile)
            && finallyRestorationCovers(restoration, node)
          ));
        if (
          reported.has(key)
          || info.before.restoresAllMocks
          || info.after.restoresAllMocks
          || restoredAfterOverride
        ) continue;
        reported.add(key);
        issues.push({
          line: lineOf(sourceFile, node),
          message: `${key} spy implementation can leak into another test; restore spies in an applicable beforeEach or afterEach`,
        });
        continue;
      }
      if (!info.before.usesClearAllMocks && !info.after.usesClearAllMocks) continue;
      if (
        reported.has(key)
        || isProtectedBefore(info, key, root)
        || isResetAfter(info, key)
      ) continue;

      reported.add(key);
      issues.push({
        line: lineOf(sourceFile, node),
        message: `${key} can carry a per-test implementation into another test through clearAllMocks(); reset or re-arm it in beforeEach`,
      });
    }
  }

  return issues;
}

function auditFile(file) {
  return auditText(file, fs.readFileSync(file, 'utf8'));
}

function assertRegressionFixture(name, source, expectedMessage) {
  const issues = auditText(`${name}.test.ts`, source);
  if (!issues.some(({ message }) => message.includes(expectedMessage))) {
    throw new Error(
      `Test-integrity regression fixture "${name}" did not report "${expectedMessage}"; actual: ${
        issues.map(({ message }) => message).join('; ') || 'none'
      }`,
    );
  }
}

function assertCleanRegressionFixture(name, source) {
  const issues = auditText(`${name}.test.ts`, source);
  if (issues.length > 0) {
    throw new Error(
      `Test-integrity clean fixture "${name}" unexpectedly reported: ${
        issues.map(({ message }) => message).join('; ')
      }`,
    );
  }
}

function assertSingleRegressionFixture(name, source, expectedMessage) {
  const issues = auditText(`${name}.test.ts`, source)
    .filter(({ message }) => message.includes(expectedMessage));
  if (issues.length !== 1) {
    throw new Error(
      `Test-integrity regression fixture "${name}" reported ${issues.length} copies of "${
        expectedMessage
      }" instead of exactly one`,
    );
  }
}

assertRegressionFixture(
  'parameterized-early-return',
  `
    it.each([1])('case %s', (value) => {
      if (value) return;
      expect(runSystem()).toBe(true);
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'expression-early-return',
  `
    it.each([1])('case %s', (value) => {
      if (value) return undefined;
      expect(runSystem()).toBe(true);
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'promise-early-return',
  `
    it('does not silently skip', () => {
      if (featureUnavailable()) return Promise.resolve();
      expect(runSystem()).toBe(true);
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'parameterized-input-only-expectation',
  `
    test.each([[1, 1]])('case %s', (actual, expected) => {
      expect(actual).toBe(expected);
    });
  `,
  'expectation compares only test-table inputs',
);
assertRegressionFixture(
  'parameterized-mock-leak',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it.each([1])('case %s', () => {
      sharedMock.mockResolvedValue('overridden');
    });
    it('consumes the default', async () => {
      expect(await sharedMock()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertCleanRegressionFixture(
  'valid-parameterized-test',
  `
    function runSystem(value) {
      return value * 2;
    }
    it.each([[1, 2]])('case %s', (input, expected) => {
      expect(runSystem(input)).toBe(expected);
    });
  `,
);
assertCleanRegressionFixture(
  'parameterized-shadowed-local-mock',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it.each([1])('overrides local case %s', async () => {
      const sharedMock = vi.fn();
      sharedMock.mockResolvedValue('local');
      expect(await sharedMock()).toBe('local');
    });
    it('uses the untouched shared mock', async () => {
      expect(await sharedMock()).toBeUndefined();
    });
  `,
);
assertRegressionFixture(
  'nested-shadow-does-not-hide-shared-leak',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it.each([1])('overrides shared case %s', async () => {
      sharedMock.mockResolvedValue('leaked');
      {
        const sharedMock = vi.fn();
        expect(await sharedMock()).toBeUndefined();
      }
    });
    it('consumes the shared default', async () => {
      expect(await sharedMock()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'sibling-reset-hook-does-not-hide-leak',
  `
    const sharedMock = vi.fn();
    describe('leaky suite', () => {
      beforeEach(() => vi.clearAllMocks());
      it('overrides shared mock', () => {
        sharedMock.mockReturnValue('leaked');
      });
      it('consumes shared default', () => {
        expect(sharedMock()).toBeUndefined();
      });
    });
    describe('unrelated protected suite', () => {
      beforeEach(() => vi.resetAllMocks());
      it('has independent protection', () => {
        expect(sharedMock()).toBeUndefined();
      });
    });
  `,
  'can carry a per-test implementation into another test',
);
assertCleanRegressionFixture(
  'fresh-local-harness-mocks',
  `
    function makeHarness() {
      const rpc = vi.fn();
      return { rpc };
    }
    beforeEach(() => vi.clearAllMocks());
    it.each([1])('overrides local case %s', async () => {
      const { rpc } = makeHarness();
      rpc.mockResolvedValue('local');
      expect(await rpc()).toBe('local');
    });
    it('uses an independent local mock', async () => {
      const { rpc } = makeHarness();
      expect(await rpc()).toBeUndefined();
    });
  `,
);
assertRegressionFixture(
  'destructured-shared-mock-leak',
  `
    const { sharedMock } = vi.hoisted(() => ({ sharedMock: vi.fn() }));
    beforeEach(() => vi.clearAllMocks());
    it('overrides the destructured shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
    it('consumes the destructured shared default', () => {
      expect(sharedMock()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'element-access-shared-mock-leak',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it('overrides through a static element-access method', () => {
      sharedMock['mockReturnValue']('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertCleanRegressionFixture(
  'element-access-shared-mock-reset',
  `
    const sharedMock = vi.fn();
    beforeEach(() => {
      vi.clearAllMocks();
      sharedMock['mockReset']();
    });
    it('overrides through a static element-access method safely', () => {
      sharedMock['mockReturnValue']('isolated');
      expect(sharedMock()).toBe('isolated');
    });
  `,
);
assertRegressionFixture(
  'dynamic-element-access-shared-method-fails-closed',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it('uses a computed method on a shared mock', () => {
      sharedMock[getMockMethod()]('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'computed shared method call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'destructured-callback-local-mock',
  `
    const { sharedMock } = vi.hoisted(() => ({ sharedMock: vi.fn() }));
    beforeEach(() => vi.clearAllMocks());
    it('overrides a destructured local mock', () => {
      const { sharedMock } = { sharedMock: vi.fn() };
      sharedMock.mockReturnValue('local');
      expect(sharedMock()).toBe('local');
    });
    it('uses the untouched shared mock', () => {
      expect(sharedMock()).toBeUndefined();
    });
  `,
);
assertRegressionFixture(
  'dead-hook-helper-does-not-protect-leak',
  `
    const sharedMock = vi.fn();
    beforeEach(() => {
      vi.clearAllMocks();
      function unused() {
        vi.resetAllMocks();
        sharedMock.mockReset();
      }
    });
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
    it('consumes the shared default', () => {
      expect(sharedMock()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'persistent-override-requires-isolation-without-direct-consumer',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it('overrides the shared mock without a shared consumer', () => {
      sharedMock.mockReturnValue('unused');
    });
    it('uses only a same-named local mock', () => {
      const sharedMock = vi.fn();
      expect(sharedMock()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'indirect-sut-consumer',
  `
    const sharedMock = vi.fn();
    vi.mock('./dependency', () => ({ authorize: sharedMock }));
    beforeEach(() => vi.clearAllMocks());
    it('overrides the injected dependency', () => {
      sharedMock.mockResolvedValue({ allowed: true });
    });
    it('invokes only the system under test', async () => {
      expect(await runSystemUnderTest()).toBeDefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'unconsumed-once-implementation',
  `
    const sharedMock = vi.fn();
    beforeEach(() => vi.clearAllMocks());
    it('queues a result on a branch that does not consume it', () => {
      sharedMock.mockResolvedValueOnce('leaked');
      expect(runDifferentBranch()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'hook-once-default-is-not-protection',
  `
    const sharedMock = vi.fn();
    beforeEach(() => {
      vi.clearAllMocks();
      sharedMock.mockResolvedValueOnce('default');
    });
    it('queues an unconsumed per-test result', () => {
      sharedMock.mockResolvedValueOnce('leaked');
      expect(runDifferentBranch()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'named-clear-hook-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    function clearMocks() {
      vi.clearAllMocks();
    }
    beforeEach(clearMocks);
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'wrapper-hook-helper-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    function clearMocks() {
      vi.clearAllMocks();
    }
    beforeEach(() => clearMocks());
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'multi-hop-wrapper-hook-helper-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    function clearMocks() {
      vi.clearAllMocks();
    }
    function prepare() {
      clearMocks();
    }
    beforeEach(() => prepare());
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'object-method-hook-helper-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    const lifecycle = {
      clear() {
        vi.clearAllMocks();
      },
    };
    beforeEach(() => lifecycle.clear());
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'argument-dispatched-hook-helper-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    function invoke(cleanup) {
      cleanup();
    }
    beforeEach(() => invoke(vi.clearAllMocks));
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'hook-helper-argument-target-does-not-protect-same-named-mock',
  `
    const mock = vi.fn();
    const shared = vi.fn();
    function reset(mock) {
      mock.mockReset();
    }
    beforeEach(() => {
      vi.clearAllMocks();
      reset(shared);
    });
    it('overrides the unrelated same-named mock', () => {
      mock.mockReturnValue('leaked');
    });
  `,
  'mock can carry a per-test implementation',
);
assertRegressionFixture(
  'hook-helper-nested-argument-target-does-not-cross-protect',
  `
    const obj = { mock: vi.fn() };
    const shared = { mock: vi.fn() };
    function reset(obj) {
      obj.mock.mockReset();
    }
    beforeEach(() => {
      vi.clearAllMocks();
      reset(shared);
    });
    it('overrides the unrelated nested target', () => {
      obj.mock.mockReturnValue('leaked');
    });
  `,
  'obj.mock can carry a per-test implementation',
);
assertRegressionFixture(
  'hook-helper-element-argument-target-does-not-cross-protect',
  `
    const obj = { mock: vi.fn() };
    const shared = { mock: vi.fn() };
    function reset(obj) {
      obj['mock'].mockReset();
    }
    beforeEach(() => {
      vi.clearAllMocks();
      reset(shared);
    });
    it('overrides the unrelated computed target', () => {
      obj['mock'].mockReturnValue('leaked');
    });
  `,
  "obj['mock'] can carry a per-test implementation",
);
assertRegressionFixture(
  'hook-helper-parameter-reassignment-does-not-refresh-caller',
  `
    const mock = vi.fn();
    const shared = vi.fn();
    function refresh(mock) {
      mock = vi.fn();
    }
    beforeEach(() => {
      vi.clearAllMocks();
      refresh(shared);
    });
    it('overrides the unrelated same-named mock', () => {
      mock.mockReturnValue('leaked');
    });
  `,
  'mock can carry a per-test implementation',
);
assertRegressionFixture(
  'parameter-dispatched-object-hook-helper',
  `
    const sharedMock = vi.fn();
    const lifecycle = {
      clear() {
        vi.clearAllMocks();
      },
    };
    function invoke(target) {
      target.clear();
    }
    beforeEach(() => invoke(lifecycle));
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'nested-parameter-dispatched-object-hook-helper',
  `
    const sharedMock = vi.fn();
    function invoke(wrapper) {
      wrapper.lifecycle.clear();
    }
    beforeEach(() => invoke({
      lifecycle: {
        clear() {
          vi.clearAllMocks();
        },
      },
    }));
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'direct-vi-clear-hook-still-enables-leak-analysis',
  `
    const sharedMock = vi.fn();
    beforeEach(vi.clearAllMocks);
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'unresolved-lifecycle-callback-fails-closed',
  `
    const cleanup = getCleanupCallback();
    beforeEach(cleanup);
    it('runs a test', () => {
      expect(runSystem()).toBe(true);
    });
  `,
  'beforeEach callback cannot be analyzed',
);
assertRegressionFixture(
  'unresolved-test-callback-fails-closed',
  `
    const body = getCaseCallback();
    it('runs an opaque body', body);
  `,
  'it callback cannot be analyzed',
);
assertRegressionFixture(
  'computed-title-unresolved-test-fails-closed',
  `
    const title = makeTitle();
    const body = getCaseCallback();
    it(title, body);
  `,
  'it callback cannot be analyzed',
);
assertRegressionFixture(
  'unresolved-suite-callback-fails-closed',
  `
    const body = getSuiteCallback();
    describe('runs an opaque suite', body);
  `,
  'describe callback cannot be analyzed',
);
assertCleanRegressionFixture(
  'callback-free-test-controls',
  `
    it.todo('future behavior');
    it.skip('temporarily disabled');
  `,
);
assertRegressionFixture(
  'sequential-test-unresolved-callback-fails-closed',
  `
    const body = getCaseCallback();
    test.sequential('opaque sequential case', body);
  `,
  'test callback cannot be analyzed',
);
assertRegressionFixture(
  'shuffled-suite-unresolved-callback-fails-closed',
  `
    const body = getSuiteCallback();
    describe.shuffle('opaque shuffled suite', body);
  `,
  'describe callback cannot be analyzed',
);
assertRegressionFixture(
  'shadowed-named-hook-does-not-credit-outer-cleanup',
  `
    const sharedMock = vi.fn();
    function cleanup() {
      vi.resetAllMocks();
    }
    describe('shadowed hook', () => {
      const cleanup = vi.fn();
      beforeEach(cleanup);
      it('overrides the shared mock', () => {
        sharedMock.mockReturnValue('leaked');
      });
    });
  `,
  'beforeEach callback cannot be analyzed',
);
assertRegressionFixture(
  'loop-shadowed-hook-does-not-credit-outer-cleanup',
  `
    function cleanup() {
      vi.resetAllMocks();
    }
    for (const cleanup of [() => vi.clearAllMocks()]) {
      beforeEach(cleanup);
    }
  `,
  'beforeEach callback cannot be analyzed',
);
assertRegressionFixture(
  'catch-shadowed-hook-does-not-credit-outer-cleanup',
  `
    function cleanup() {
      vi.resetAllMocks();
    }
    try {
      runSetup();
    } catch (cleanup) {
      beforeEach(cleanup);
    }
  `,
  'beforeEach callback cannot be analyzed',
);
assertRegressionFixture(
  'named-test-uses-registration-site-hook-scope',
  `
    const sharedMock = vi.fn();
    function caseBody() {
      sharedMock.mockReturnValue('leaked');
    }
    describe('registered suite', () => {
      beforeEach(() => vi.clearAllMocks());
      it('runs the named body', caseBody);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'named-suite-retains-hook-and-test-scope',
  `
    const sharedMock = vi.fn();
    function caseBody() {
      sharedMock.mockReturnValue('leaked');
    }
    function suiteBody() {
      beforeEach(() => vi.clearAllMocks());
      it('runs the named body', caseBody);
    }
    describe('registered named suite', suiteBody);
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'nested-named-suite-retains-registration-scope',
  `
    const sharedMock = vi.fn();
    function innerSuite() {
      it('overrides the shared mock', () => {
        sharedMock.mockReturnValue('leaked');
      });
    }
    describe('outer suite', () => {
      beforeEach(vi.clearAllMocks);
      describe('registered named inner suite', innerSuite);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'repeated-named-suite-registration-fails-closed',
  `
    function commonSuite() {
      it('runs common behavior', () => {
        expect(runSystem()).toBe(true);
      });
    }
    describe('first parent', () => {
      describe('common', commonSuite);
    });
    describe('second parent', () => {
      describe('common again', commonSuite);
    });
  `,
  'describe callback is registered multiple times',
);
assertRegressionFixture(
  'after-each-clear-does-not-reset-implementation',
  `
    const sharedMock = vi.fn();
    afterEach(() => vi.clearAllMocks());
    it('overrides the shared mock', () => {
      sharedMock.mockReturnValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertCleanRegressionFixture(
  'after-each-clear-with-reset',
  `
    const sharedMock = vi.fn();
    afterEach(() => {
      vi.clearAllMocks();
      sharedMock.mockReset();
    });
    it('overrides the shared mock safely', () => {
      sharedMock.mockReturnValue('isolated');
    });
  `,
);
assertRegressionFixture(
  'conditional-hook-reset-is-not-protection',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(() => {
      vi.clearAllMocks();
      if (false) mocks.rpc.mockReset();
    });
    it('overrides the shared mock', () => {
      mocks.rpc.mockResolvedValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'early-exit-before-hook-reset-is-not-protection',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(() => {
      vi.clearAllMocks();
      if (skipCleanup()) return;
      mocks.rpc.mockReset();
    });
    it('overrides the shared mock', () => {
      mocks.rpc.mockResolvedValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'shared-spy-requires-restoration',
  `
    const service = { read: () => 'original' };
    beforeEach(() => vi.clearAllMocks());
    it('overrides a shared service', () => {
      vi.spyOn(service, 'read').mockReturnValue('leaked');
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'two-step-shared-spy-requires-restoration',
  `
    it('overrides a shared console method', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'assignment-created-spy-requires-restoration',
  `
    it('tracks a spy assigned after declaration', () => {
      let spy;
      spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'two-step-shared-spy-with-end-of-test-restoration',
  `
    it('can fail before restoring a shared console method', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      expect(runSystem()).toBe(true);
      spy.mockRestore();
    });
  `,
  'spy implementation can leak',
);
assertCleanRegressionFixture(
  'two-step-shared-spy-with-finally-restoration',
  `
    it('restores a shared console method in finally', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      try {
        expect(runSystem()).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  `,
);
assertCleanRegressionFixture(
  'inline-spy-with-finally-restore-all',
  `
    it('restores all spies in finally', () => {
      try {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(runSystem()).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });
  `,
);
assertCleanRegressionFixture(
  'return-inside-try-still-runs-first-finally-restoration',
  `
    it('restores even when the try returns', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      try {
        expect(runSystem()).toBe(true);
        if (skipTest()) return;
      } finally {
        spy.mockRestore();
      }
    });
  `,
);
assertRegressionFixture(
  'throwing-prefix-in-finally-does-not-protect-spy',
  `
    it('can throw before finally restoration', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      try {
        expect(runSystem()).toBe(true);
      } finally {
        mayThrow();
        spy.mockRestore();
      }
    });
  `,
  'spy implementation can leak',
);
assertCleanRegressionFixture(
  'combined-chain-spy-with-finally-restoration',
  `
    it('restores a combined-chain spy in finally', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(runSystem()).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  `,
);
assertRegressionFixture(
  'same-name-sibling-spies-retain-lexical-targets',
  `
    it('does not let one sibling restore discharge another target', () => {
      {
        const spy = vi.spyOn(console, 'error');
        spy.mockImplementation(() => {});
      }
      {
        const spy = vi.spyOn(console, 'warn');
        spy.mockImplementation(() => {});
        try {
          expect(runSystem()).toBe(true);
        } finally {
          spy.mockRestore();
        }
      }
    });
  `,
  'console.error spy implementation can leak',
);
assertRegressionFixture(
  'ambient-global-spy-requires-restoration',
  `
    it('overrides a non-whitelisted ambient global', () => {
      vi.spyOn(Object, 'keys').mockReturnValue([]);
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'outer-class-spy-requires-restoration',
  `
    class Service {
      static read() {
        return 'original';
      }
    }
    it('overrides an outer class method', () => {
      vi.spyOn(Service, 'read').mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'shared-object-alias-spy-requires-restoration',
  `
    const service = { read: () => 'original' };
    it('spies through a local shared-object alias', () => {
      const alias = service;
      vi.spyOn(alias, 'read').mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'early-exit-before-spy-restoration-is-not-protection',
  `
    it('can skip direct restoration', () => {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
      if (skipCleanup()) return;
      spy.mockRestore();
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'early-exit-before-after-hook-restore-is-not-protection',
  `
    afterEach(() => {
      if (skipCleanup()) return;
      vi.restoreAllMocks();
    });
    it('overrides a shared console method', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'dead-nested-assertion-does-not-hide-early-return',
  `
    it('does not count an uncalled helper assertion', () => {
      function unused() {
        expect(runSystem()).toBe(true);
      }
      if (skipTest()) return;
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'conditional-assertion-does-not-dominate-later-return',
  `
    it('does not count an assertion on another path', () => {
      if (shouldAssert()) expect(runSystem()).toBe(true);
      if (skipTest()) return;
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'invoked-helper-shared-mock-override',
  `
    const sharedMock = vi.fn();
    beforeEach(vi.clearAllMocks);
    function overrideSharedMock() {
      sharedMock.mockReturnValue('leaked');
    }
    it('invokes the override helper', () => {
      overrideSharedMock();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'invoked-helper-parameter-substitution',
  `
    const shared = vi.fn();
    const unrelated = vi.fn();
    beforeEach(() => {
      vi.clearAllMocks();
      unrelated.mockReset();
    });
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('passes the shared mock into the helper', () => {
      override(shared);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-local-two-step-spy',
  `
    function overrideConsole() {
      const spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
    }
    it('invokes a helper that creates a two-step spy', () => {
      overrideConsole();
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'invoked-helper-local-assignment-spy',
  `
    function overrideConsole() {
      let spy;
      spy = vi.spyOn(console, 'error');
      spy.mockImplementation(() => {});
    }
    it('invokes a helper that assigns a spy handle', () => {
      overrideConsole();
      expect(runSystem()).toBe(true);
    });
  `,
  'spy implementation can leak',
);
assertRegressionFixture(
  'invoked-helper-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('leaked');
    }
    it('uses the helper default', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-destructured-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ mock = shared } = {}) {
      mock.mockReturnValue('leaked');
    }
    it('uses the destructured helper default', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-void-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('leaked');
    }
    it('uses the helper default for void zero', () => {
      override(void 0);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-forwarded-undefined-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('leaked');
    }
    function forward(value) {
      override(value);
    }
    it('forwards undefined into the helper default', () => {
      forward(undefined);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-conditional-maybe-undefined-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('leaked');
    }
    it('may select the helper default', () => {
      override(useLocal() ? vi.fn() : undefined);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-conditional-shared-or-local-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('may pass the shared mock through a conditional argument', () => {
      override(useShared() ? shared : vi.fn());
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-logical-or-shared-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('may pass the shared mock through an OR argument', () => {
      override(maybeShared() || shared);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-nullish-shared-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('may pass the shared mock through a nullish argument', () => {
      override(maybeShared() ?? shared);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-call-result-maybe-undefined-default-parameter',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('leaked');
    }
    it('cannot prove a call result bypasses the helper default', () => {
      override(maybeMock());
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-local-does-not-use-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('local');
    }
    it('uses an explicit local mock', () => {
      const local = vi.fn();
      override(local);
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-local-factory-result-does-not-use-default',
  `
    const shared = vi.fn();
    const makeLocal = () => vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('local');
    }
    it('uses a local factory mock', () => {
      const local = makeLocal();
      override(local);
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-function-factory-result-does-not-use-default',
  `
    const shared = vi.fn();
    function makeLocal() {
      return vi.fn();
    }
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('local');
    }
    it('uses a local function-factory mock', () => {
      const local = makeLocal();
      override(local);
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-block-arrow-factory-result-does-not-use-default',
  `
    const shared = vi.fn();
    const makeLocal = () => {
      return vi.fn();
    };
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('local');
    }
    it('uses a local block-arrow factory mock', () => {
      const local = makeLocal();
      override(local);
      expect(local()).toBe('local');
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-shared-factory-result',
  `
    const shared = vi.fn();
    const selectMock = () => shared;
    beforeEach(vi.clearAllMocks);
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('passes a shared mock returned by a local factory', () => {
      override(selectMock());
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-identity-factory-shared-result',
  `
    const shared = vi.fn();
    function identity(mock) {
      return mock;
    }
    beforeEach(vi.clearAllMocks);
    function override(mock) {
      mock.mockReturnValue('leaked');
    }
    it('passes shared state through a parameterized factory', () => {
      override(identity(shared));
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'invoked-helper-temp-variable-local-factory-does-not-use-default',
  `
    const shared = vi.fn();
    function makeLocal() {
      const mock = vi.fn();
      return mock;
    }
    beforeEach(vi.clearAllMocks);
    function override(mock = shared) {
      mock.mockReturnValue('local');
    }
    it('uses a temp-variable local factory mock', () => {
      const local = makeLocal();
      override(local);
      expect(local()).toBe('local');
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-destructured-object-argument',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ mock }) {
      mock.mockReturnValue('leaked');
    }
    it('maps an inline object property to a destructured parameter', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-nested-destructured-object-argument',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock } }) {
      mock.mockReturnValue('leaked');
    }
    it('maps a nested object property to a destructured parameter', () => {
      override({ nested: { mock: shared } });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-destructured-array-argument',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override([mock]) {
      mock.mockReturnValue('leaked');
    }
    it('maps an array element to a destructured parameter', () => {
      override([shared]);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-factory-destructured-object-argument',
  `
    const shared = vi.fn();
    function wrap(mock) {
      return { mock };
    }
    beforeEach(vi.clearAllMocks);
    function override({ mock }) {
      mock.mockReturnValue('leaked');
    }
    it('preserves a factory environment through object projection', () => {
      override(wrap(shared));
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-factory-destructured-array-argument',
  `
    const shared = vi.fn();
    function wrap(mock) {
      return [mock];
    }
    beforeEach(vi.clearAllMocks);
    function override([mock]) {
      mock.mockReturnValue('leaked');
    }
    it('preserves a factory environment through array projection', () => {
      override(wrap(shared));
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-object-value-skips-binding-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ mock = shared }) {
      mock.mockReturnValue('local');
    }
    it('uses an explicit local object property', () => {
      const local = vi.fn();
      override({ mock: local });
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-nested-value-skips-binding-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock = shared } }) {
      mock.mockReturnValue('local');
    }
    it('uses an explicit local nested property', () => {
      const local = vi.fn();
      override({ nested: { mock: local } });
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-array-value-skips-binding-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override([mock = shared]) {
      mock.mockReturnValue('local');
    }
    it('uses an explicit local array element', () => {
      const local = vi.fn();
      override([local]);
      expect(local()).toBe('local');
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-object-spread-argument',
  `
    const shared = vi.fn();
    const holder = { mock: shared };
    beforeEach(vi.clearAllMocks);
    function override({ mock }) {
      mock.mockReturnValue('leaked');
    }
    it('maps a shared property through an object spread', () => {
      override({ ...holder });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-array-spread-argument',
  `
    const shared = vi.fn();
    const holder = [shared];
    beforeEach(vi.clearAllMocks);
    function override([mock]) {
      mock.mockReturnValue('leaked');
    }
    it('maps a shared element through an array spread', () => {
      override([...holder]);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-nested-object-leaf-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock = shared } = {} }) {
      mock.mockReturnValue('leaked');
    }
    it('uses a nested leaf default', () => {
      override({ nested: {} });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-nested-array-leaf-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: [mock = shared] = [] }) {
      mock.mockReturnValue('leaked');
    }
    it('uses a nested array leaf default', () => {
      override({ nested: [] });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'invoked-helper-outer-object-default-suppresses-leaf-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock = shared } = { mock: vi.fn() } }) {
      mock.mockReturnValue('local');
    }
    it('uses the nonundefined outer object default', () => {
      override({});
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-outer-array-default-suppresses-leaf-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: [mock = shared] = [vi.fn()] }) {
      mock.mockReturnValue('local');
    }
    it('uses the nonundefined outer array default', () => {
      override({});
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-undefined-uses-outer-object-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock = shared } = { mock: vi.fn() } }) {
      mock.mockReturnValue('local');
    }
    it('uses the outer object default for explicit undefined', () => {
      override({ nested: undefined });
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-explicit-undefined-uses-outer-array-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ nested: [mock = shared] = [vi.fn()] }) {
      mock.mockReturnValue('local');
    }
    it('uses the outer array default for explicit undefined', () => {
      override({ nested: undefined });
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-undefined-alias-uses-outer-object-default',
  `
    const shared = vi.fn();
    const absent = undefined;
    beforeEach(vi.clearAllMocks);
    function override({ nested: { mock = shared } = { mock: vi.fn() } }) {
      mock.mockReturnValue('local');
    }
    it('uses the outer object default through an undefined alias', () => {
      override({ nested: absent });
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-mutable-computed-binding-fails-closed',
  `
    const shared = vi.fn();
    let key = 'safe';
    key = 'mock';
    beforeEach(vi.clearAllMocks);
    function override({ [key]: mock }) {
      mock.mockReturnValue('leaked');
    }
    it('cannot trust a mutable computed binding key', () => {
      override({ safe: vi.fn(), mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'computed binding key cannot be analyzed safely',
);
assertRegressionFixture(
  'invoked-helper-object-rest-fails-closed',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ ...rest }) {
      rest.mock.mockReturnValue('leaked');
    }
    it('cannot safely project object rest mutation', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-object-rest-alias',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ ...rest }) {
      const mock = rest.mock;
      mock.mockReturnValue('leaked');
    }
    it('maps an alias derived from object rest', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-object-rest-deep-alias',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ ...rest }) {
      const holder = { inner: rest };
      const mock = holder.inner.mock;
      mock.mockReturnValue('leaked');
    }
    it('maps a deep alias derived from object rest', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'destructured rest mock mutation cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'invoked-helper-object-rest-unrelated-sibling-remains-clean',
  `
    function configure({ ...rest }) {
      const holder = { tainted: rest, safe: vi.fn() };
      holder.safe.mockReturnValue('local');
      expect(holder.safe()).toBe('local');
    }
    it('does not taint an unrelated fresh sibling', () => {
      configure({ mock: vi.fn() });
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-object-rest-unrelated-array-sibling-remains-clean',
  `
    function configure({ ...rest }) {
      const holder = [rest, vi.fn()];
      holder[1].mockReturnValue('local');
      expect(holder[1]()).toBe('local');
    }
    it('does not taint an unrelated fresh array sibling', () => {
      configure({ mock: vi.fn() });
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-object-rest-unrelated-nested-array-sibling-remains-clean',
  `
    function configure({ ...rest }) {
      const holder = { nested: [rest, vi.fn()] };
      holder.nested[1].mockReturnValue('local');
      expect(holder.nested[1]()).toBe('local');
    }
    it('does not taint an unrelated nested fresh array sibling', () => {
      configure({ mock: vi.fn() });
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-object-rest-unrelated-deep-array-object-sibling-remains-clean',
  `
    function configure({ ...rest }) {
      const holder = { nested: [rest, { safe: vi.fn() }] };
      holder.nested[1].safe.mockReturnValue('local');
      expect(holder.nested[1].safe()).toBe('local');
    }
    it('does not taint a property under an unrelated deep array sibling', () => {
      configure({ mock: vi.fn() });
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-literal-computed-binding-key',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override({ ['mock']: mock }) {
      mock.mockReturnValue('leaked');
    }
    it('maps a literal computed binding key', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-const-computed-binding-key',
  `
    const shared = vi.fn();
    const key = 'mock';
    beforeEach(vi.clearAllMocks);
    function override({ [key]: mock }) {
      mock.mockReturnValue('leaked');
    }
    it('maps a const computed binding key', () => {
      override({ mock: shared });
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-array-rest-fails-closed',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override([first, ...rest]) {
      rest[0].mockReturnValue('leaked');
    }
    it('cannot safely project array rest mutation', () => {
      override([vi.fn(), shared]);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'invoked-helper-object-rest-local-mock-remains-clean',
  `
    function configure({ ...rest }) {
      rest.mock.mockReturnValue('local');
    }
    it('configures a fresh local object-rest mock', () => {
      const local = vi.fn();
      configure({ mock: local });
      expect(local()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'invoked-helper-array-rest-local-mock-remains-clean',
  `
    function configure([first, ...rest]) {
      rest[0].mockReturnValue('local');
    }
    it('configures a fresh local array-rest mock', () => {
      const local = vi.fn();
      configure([vi.fn(), local]);
      expect(local()).toBe('local');
    });
  `,
);
assertRegressionFixture(
  'invoked-helper-cross-parameter-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(fallback, mock = fallback) {
      mock.mockReturnValue('leaked');
    }
    it('uses an earlier parameter as the default', () => {
      override(shared);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'invoked-helper-destructured-cross-parameter-default',
  `
    const shared = vi.fn();
    beforeEach(vi.clearAllMocks);
    function override(fallback, { mock = fallback } = {}) {
      mock.mockReturnValue('leaked');
    }
    it('uses an earlier parameter in a destructured default', () => {
      override(shared);
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'parameter-dispatched-inline-callback-helper',
  `
    const sharedMock = vi.fn();
    beforeEach(vi.clearAllMocks);
    function invoke(callback) {
      callback();
    }
    it('invokes an inline callback through a helper', () => {
      invoke(() => sharedMock.mockReturnValue('leaked'));
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'parameter-dispatched-named-callback-helper',
  `
    const sharedMock = vi.fn();
    beforeEach(vi.clearAllMocks);
    function invoke(callback) {
      callback();
    }
    function override() {
      sharedMock.mockReturnValue('leaked');
    }
    it('invokes a named callback through a helper', () => {
      invoke(override);
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'parameter-dispatched-object-method-callback-helper',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    function invoke(callback) {
      callback();
    }
    beforeEach(vi.clearAllMocks);
    it('passes an object method by reference', () => {
      invoke(helpers.override);
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'parameter-dispatched-aliased-object-method-callback-helper',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    const alias = helpers;
    function invoke(callback) {
      callback();
    }
    beforeEach(vi.clearAllMocks);
    it('passes an aliased object method by reference', () => {
      invoke(alias.override);
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'invoked-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invokes the object method helper', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'multi-hop-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    function invokeHelper() {
      helpers.override();
    }
    beforeEach(vi.clearAllMocks);
    it('invokes the object helper through a function', () => {
      invokeHelper();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'aliased-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    const alias = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes an aliased object helper', () => {
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'shorthand-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    function override() {
      sharedMock.mockReturnValue('leaked');
    }
    const helpers = { override };
    beforeEach(vi.clearAllMocks);
    it('invokes a shorthand object helper', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'aliased-shorthand-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    function override() {
      sharedMock.mockReturnValue('leaked');
    }
    const helpers = { override };
    const alias = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes an aliased shorthand object helper', () => {
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'function-valued-object-property-helper-override',
  `
    const sharedMock = vi.fn();
    function overrideFn() {
      sharedMock.mockReturnValue('leaked');
    }
    const helpers = { override: overrideFn };
    beforeEach(vi.clearAllMocks);
    it('invokes a function-valued object property', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'aliased-function-valued-object-property-helper-override',
  `
    const sharedMock = vi.fn();
    function overrideFn() {
      sharedMock.mockReturnValue('leaked');
    }
    const helpers = { override: overrideFn };
    const alias = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes an aliased function-valued object property', () => {
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'element-access-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invokes a string-indexed object helper', () => {
      helpers['override']();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'aliased-element-access-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    const alias = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes an aliased string-indexed object helper', () => {
      alias['override']();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'parameter-dispatched-element-access-callback-helper',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    function invoke(callback) {
      callback();
    }
    beforeEach(vi.clearAllMocks);
    it('passes a string-indexed object method by reference', () => {
      invoke(helpers['override']);
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'nested-element-access-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    const wrapper = {
      helpers: {
        override() {
          sharedMock.mockReturnValue('leaked');
        },
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invokes a nested string-indexed object helper', () => {
      wrapper['helpers']['override']();
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'dynamic-element-access-object-helper-fails-closed',
  `
    const sharedMock = vi.fn();
    const helpers = {
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('uses a dynamic helper key', () => {
      helpers[getHelperKey()]();
      expect(runSystem()).toBe(true);
    });
  `,
  'computed helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'factory-produced-dynamic-object-helper-fails-closed',
  `
    const sharedMock = vi.fn();
    const makeHelpers = () => ({
      override() {
        sharedMock.mockReturnValue('leaked');
      },
    });
    const helpers = makeHelpers();
    beforeEach(vi.clearAllMocks);
    it('uses a dynamic key on factory-produced helpers', () => {
      helpers[getHelperKey()]();
      expect(runSystem()).toBe(true);
    });
  `,
  'computed helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'temp-return-factory-dynamic-object-helper-fails-closed',
  `
    const sharedMock = vi.fn();
    function makeHelpers() {
      const value = {
        override() {
          sharedMock.mockReturnValue('leaked');
        },
      };
      return value;
    }
    const helpers = makeHelpers();
    beforeEach(vi.clearAllMocks);
    it('uses a dynamic key on temp-return helpers', () => {
      helpers[getHelperKey()]();
      expect(runSystem()).toBe(true);
    });
  `,
  'computed helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'spread-inherited-object-helper-override',
  `
    const shared = vi.fn();
    const source = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    const helpers = { ...source };
    beforeEach(vi.clearAllMocks);
    it('invokes a helper inherited through spread', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'later-object-helper-property-overrides-spread',
  `
    const shared = vi.fn();
    const source = {
      override() {
        shared.mockReturnValue('not reached');
      },
    };
    const helpers = {
      ...source,
      override() {},
    };
    beforeEach(vi.clearAllMocks);
    it('uses the later direct helper property', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'computed-property-object-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      ['override']() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invokes a literal-computed helper property', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'factory-closure-object-helper-override',
  `
    const shared = vi.fn();
    function makeHelpers(mock) {
      return {
        override() {
          mock.mockReturnValue('leaked');
        },
      };
    }
    const helpers = makeHelpers(shared);
    beforeEach(vi.clearAllMocks);
    it('preserves a factory closure environment', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'extracted-object-method-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    const run = helpers.override;
    beforeEach(vi.clearAllMocks);
    it('invokes an extracted helper method', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'transitively-aliased-object-method-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    const first = helpers.override;
    const second = first;
    beforeEach(vi.clearAllMocks);
    it('invokes a transitively aliased helper method', () => {
      second();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'destructured-object-method-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    const { override } = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes a destructured helper method', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'nested-destructured-object-method-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      nested: {
        override() {
          shared.mockReturnValue('leaked');
        },
      },
    };
    const { nested: { override } } = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes a nested destructured helper method', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'nested-array-destructured-helper-override',
  `
    const shared = vi.fn();
    const helpers = [[() => shared.mockReturnValue('leaked')]];
    const [[override]] = helpers;
    beforeEach(vi.clearAllMocks);
    it('invokes a nested array-destructured helper', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'factory-captured-destructured-helper-override',
  `
    const shared = vi.fn();
    function makeHelpers(mock) {
      return {
        override() {
          mock.mockReturnValue('leaked');
        },
      };
    }
    const { override } = makeHelpers(shared);
    beforeEach(vi.clearAllMocks);
    it('preserves a factory environment through destructuring', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'factory-captured-nested-destructured-helper-alias-override',
  `
    const shared = vi.fn();
    function makeHelpers(mock) {
      return {
        nested: [{
          override() {
            mock.mockReturnValue('leaked');
          },
        }],
      };
    }
    const { nested: [{ override }] } = makeHelpers(shared);
    const run = override;
    beforeEach(vi.clearAllMocks);
    it('preserves a factory environment through nested destructuring and aliasing', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'factory-captured-shorthand-destructured-helper-override',
  `
    const shared = vi.fn();
    function makeHelpers(mock) {
      const override = () => mock.mockReturnValue('leaked');
      return { override };
    }
    const { override } = makeHelpers(shared);
    beforeEach(vi.clearAllMocks);
    it('preserves a factory environment for shorthand callables', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'factory-captured-named-declaration-destructured-helper-override',
  `
    const shared = vi.fn();
    function makeHelpers(mock) {
      function override() {
        mock.mockReturnValue('leaked');
      }
      return { override };
    }
    const { override } = makeHelpers(shared);
    beforeEach(vi.clearAllMocks);
    it('preserves factory capture for a named local declaration', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'nested-destructured-helper-default-from-undefined',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    const holder = { nested: undefined };
    const {
      nested: { override } = { override: leak },
    } = holder;
    beforeEach(vi.clearAllMocks);
    it('uses a nested callable default for explicit undefined', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'nested-array-destructured-helper-default-from-undefined-alias',
  `
    const shared = vi.fn();
    const absent = undefined;
    function leak() {
      shared.mockReturnValue('leaked');
    }
    const holder = [absent];
    const [
      [override] = [leak],
    ] = holder;
    beforeEach(vi.clearAllMocks);
    it('uses an array callable default for aliased undefined', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'array-destructured-helper-default-from-hole',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    const [override = leak] = [,];
    beforeEach(vi.clearAllMocks);
    it('uses a callable default for an array hole', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'destructured-object-method-hook-helper',
  `
    const shared = vi.fn();
    const lifecycle = {
      clear() {
        vi.clearAllMocks();
      },
    };
    const { clear } = lifecycle;
    beforeEach(() => clear());
    it('summarizes a destructured hook helper', () => {
      shared.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'assignment-created-helper-override',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('follows a dominating helper assignment', () => {
      let run;
      run = leak;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'object-destructuring-assignment-created-helper-override',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('follows an object destructuring helper assignment', () => {
      let run;
      ({ override: run } = helpers);
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'nested-array-destructuring-assignment-helper-alias-override',
  `
    const shared = vi.fn();
    const helpers = { nested: [[() => shared.mockReturnValue('leaked')]] };
    beforeEach(vi.clearAllMocks);
    it('follows nested array assignment and aliasing', () => {
      let override;
      ({ nested: [[override]] } = helpers);
      const run = override;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'conditional-object-destructuring-assignment-helper-fails-closed',
  `
    const shared = vi.fn();
    const safe = { run() {} };
    const leaky = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('does not trust a conditional destructuring assignment', () => {
      let run = safe.run;
      if (useLeak()) ({ run } = leaky);
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'object-rest-assignment-helper-dispatch-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('does not trust member dispatch through assignment rest', () => {
      let rest;
      ({ ...rest } = helpers);
      rest.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'aliased-object-rest-assignment-helper-dispatch-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('follows an assignment-rest alias before member dispatch', () => {
      let rest;
      ({ ...rest } = helpers);
      const alias = rest;
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'destructured-alias-from-object-rest-assignment-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('follows destructuring from an assignment-rest receiver', () => {
      let rest;
      ({ ...rest } = helpers);
      const { override: run } = rest;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'deep-destructured-alias-from-object-rest-assignment-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      nested: {
        override() {
          shared.mockReturnValue('leaked');
        },
      },
    };
    beforeEach(vi.clearAllMocks);
    it('follows nested destructuring from an assignment-rest receiver', () => {
      let rest;
      ({ ...rest } = helpers);
      const { nested: { override: run } } = rest;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'staged-deep-destructured-alias-from-object-rest-assignment-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      nested: {
        override() {
          shared.mockReturnValue('leaked');
        },
      },
    };
    beforeEach(vi.clearAllMocks);
    it('preserves the path through staged assignment-rest destructuring', () => {
      let rest;
      ({ ...rest } = helpers);
      const { nested } = rest;
      const { override: run } = nested;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'object-rest-reprojection-alias-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      ignored: 1,
      override() {
        shared.mockReturnValue('leaked');
      },
    };
    let rest;
    ({ ...rest } = helpers);
    const { ignored, ...alias } = rest;
    beforeEach(vi.clearAllMocks);
    it('follows members retained by a second object-rest projection', () => {
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'nested-object-rest-reprojection-alias-fails-closed',
  `
    const shared = vi.fn();
    const helpers = {
      nested: {
        override() {
          shared.mockReturnValue('leaked');
        },
      },
    };
    let rest;
    ({ ...rest } = helpers);
    const { nested: { ...alias } } = rest;
    beforeEach(vi.clearAllMocks);
    it('preserves the prefix before a nested rest projection', () => {
      alias.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'harmless-object-rest-assignment-dispatch-remains-clean',
  `
    let rest;
    ({ ...rest } = { run() {} });
    it('permits a harmless method reached through assignment rest', () => {
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'harmless-staged-deep-object-rest-assignment-dispatch-remains-clean',
  `
    let rest;
    ({ ...rest } = { nested: { run() {} } });
    const { nested } = rest;
    const { run } = nested;
    it('permits a harmless method reached through staged rest destructuring', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'harmless-array-rest-reprojection-dispatch-remains-clean',
  `
    let rest;
    ({ ...rest } = {
      list: [
        () => {},
        () => {},
      ],
    });
    const { list } = rest;
    const [skip, ...tail] = list;
    it('maps a projected array index back to its source index', () => {
      tail[0]();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-array-rest-reprojection-dispatch-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      list: [
        () => {},
        () => shared.mockReturnValue('leaked'),
      ],
    });
    const { list } = rest;
    const [skip, ...tail] = list;
    beforeEach(vi.clearAllMocks);
    it('maps a dirty projected array callback back to its source index', () => {
      tail[0]();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'harmless-inline-nested-array-rest-reprojection-remains-clean',
  `
    let rest;
    ({ ...rest } = {
      list: [
        () => {},
        { run() {} },
      ],
    });
    const { list } = rest;
    const [skip, ...[{ run }]] = list;
    it('normalizes an inline array-rest offset before nested destructuring', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'harmless-chained-inline-array-rest-reprojection-remains-clean',
  `
    let rest;
    ({ ...rest } = {
      list: [
        () => {},
        () => {},
        () => {},
      ],
    });
    const { list } = rest;
    const [skip, ...[skip2, ...tail]] = list;
    it('combines consecutive inline array-rest offsets', () => {
      tail[0]();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-nested-member-after-array-rest-reprojection-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      list: [
        {},
        {
          run() {
            shared.mockReturnValue('leaked');
          },
        },
      ],
    });
    const { list } = rest;
    const [skip, ...tail] = list;
    beforeEach(vi.clearAllMocks);
    it('preserves array-rest provenance through nested member dispatch', () => {
      tail[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'harmless-assignment-array-rest-reprojection-remains-clean',
  `
    let rest;
    ([, ...rest] = [0, () => {}]);
    it('maps an assignment-form array-rest callback to its source index', () => {
      rest[0]();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-assignment-array-rest-nested-member-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [
      0,
      {
        run() {
          shared.mockReturnValue('leaked');
        },
      },
    ]);
    beforeEach(vi.clearAllMocks);
    it('maps assignment-form array-rest nested members to the source index', () => {
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'dirty-array-rest-element-alias-member-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [
      0,
      {
        run() {
          shared.mockReturnValue('leaked');
        },
      },
    ]);
    const item = rest[0];
    beforeEach(vi.clearAllMocks);
    it('preserves assignment-rest provenance through an element alias', () => {
      item.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'dirty-rest-member-overwrite-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = { run() {} });
    beforeEach(vi.clearAllMocks);
    it('analyzes a dominating rest-member replacement', () => {
      rest.run = () => shared.mockReturnValue('leaked');
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'safe-rest-member-overwrite-clears-source-risk',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      run() {
        shared.mockReturnValue('not reached');
      },
    });
    beforeEach(vi.clearAllMocks);
    it('trusts a dominating harmless rest-member replacement', () => {
      rest.run = () => {};
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-rest-member-overwrite-through-alias-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = { run() {} });
    const alias = rest;
    beforeEach(vi.clearAllMocks);
    it('tracks a dirty member write through an identity-preserving alias', () => {
      alias.run = () => shared.mockReturnValue('leaked');
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'safe-rest-member-overwrite-through-alias-clears-source-risk',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      run() {
        shared.mockReturnValue('not reached');
      },
    });
    const alias = rest;
    beforeEach(vi.clearAllMocks);
    it('tracks a safe member write through an identity-preserving alias', () => {
      alias.run = () => {};
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-array-element-alias-member-write-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [0, { run() {} }]);
    const item = rest[0];
    beforeEach(vi.clearAllMocks);
    it('tracks a dirty member write through an array-element alias', () => {
      item.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'safe-array-element-alias-member-write-clears-source-risk',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [
      0,
      {
        run() {
          shared.mockReturnValue('not reached');
        },
      },
    ]);
    const item = rest[0];
    beforeEach(vi.clearAllMocks);
    it('tracks a safe member write through an array-element alias', () => {
      item.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dirty-destructured-array-element-alias-write-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [0, { run() {} }]);
    const [item] = rest;
    beforeEach(vi.clearAllMocks);
    it('tracks a dirty write through a destructured element alias', () => {
      item.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'safe-assigned-array-element-alias-write-clears-source-risk',
  `
    const shared = vi.fn();
    let rest;
    ([, ...rest] = [
      0,
      {
        run() {
          shared.mockReturnValue('not reached');
        },
      },
    ]);
    let item;
    [item] = rest;
    beforeEach(vi.clearAllMocks);
    it('tracks a safe write through an assignment-form element alias', () => {
      item.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'reaching-alias-rebind-to-rest-shares-member-writes',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = { run() {} });
    let alias = { run() {} };
    alias = rest;
    beforeEach(vi.clearAllMocks);
    it('uses the reaching alias identity after rebinding', () => {
      alias.run = () => shared.mockReturnValue('leaked');
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'reaching-alias-rebind-away-from-rest-separates-member-writes',
  `
    let rest;
    ({ ...rest } = { run() {} });
    let alias = rest;
    alias = { run() {} };
    it('uses the independent reaching identity after rebinding', () => {
      alias.run = () => {};
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'conditional-alias-rebind-toward-rest-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = { run() {} });
    let alias = { run() {} };
    if (useRest()) alias = rest;
    beforeEach(vi.clearAllMocks);
    it('joins the possible rest identity after a conditional rebind', () => {
      alias.run = () => shared.mockReturnValue('leaked');
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'conditional-alias-rebind-away-does-not-clear-dirty-rest',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      run() {
        shared.mockReturnValue('leaked');
      },
    });
    let alias = rest;
    if (detach()) alias = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('does not treat a possible detached safe write as a universal clear', () => {
      alias.run = () => {};
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'safe-write-cannot-clear-unmatched-conditional-target',
  `
    const shared = vi.fn();
    let safe;
    let dirty;
    let target;
    let writer;
    ({ ...safe } = { run() {} });
    ({ ...dirty } = {
      run() {
        shared.mockReturnValue('leaked');
      },
    });
    target = dirty;
    if (flag()) target = safe;
    writer = safe;
    beforeEach(vi.clearAllMocks);
    it('retains risk from every unmatched possible target', () => {
      writer.run = () => {};
      target.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'array-rest-element-references-share-member-writes',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const [skip, ...tail] = rest;
    beforeEach(vi.clearAllMocks);
    it('preserves element identity across an array-rest copy', () => {
      tail[0].run = () => shared.mockReturnValue('leaked');
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'array-rest-copy-slot-write-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [() => {}, () => {}]);
    const [skip, ...tail] = rest;
    beforeEach(vi.clearAllMocks);
    it('tracks a slot replacement on the copied rest array', () => {
      tail[0] = () => shared.mockReturnValue('leaked');
      tail[0]();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'array-rest-copy-slot-write-through-alias-fails-closed',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [() => {}, () => {}]);
    const [skip, ...tail] = rest;
    const alias = tail;
    beforeEach(vi.clearAllMocks);
    it('shares copied-array container identity with an ordinary alias', () => {
      alias[0] = () => shared.mockReturnValue('leaked');
      tail[0]();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'array-rest-copy-slot-write-does-not-change-source-slot',
  `
    let rest;
    ([...rest] = [() => {}, () => {}]);
    const [skip, ...tail] = rest;
    it('keeps slot replacement local to the copied rest array', () => {
      tail[0] = () => {};
      rest[1]();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'redundant-array-element-alias-rebind-remains-clean',
  `
    let rest;
    let item;
    ([, ...rest] = [0, { run() {} }]);
    item = rest[0];
    item = item;
    it('preserves identity through a redundant self assignment', () => {
      item.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'captured-array-element-alias-restore-remains-clean',
  `
    let rest;
    let item;
    let alias;
    ([, ...rest] = [0, { run() {} }]);
    item = rest[0];
    alias = item;
    item = { run() {} };
    item = alias;
    it('resolves a captured identity at the point it was assigned', () => {
      item.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'captured-element-safe-write-cannot-clear-replaced-slot',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    rest[0] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('does not conflate a captured object with its replacement slot', () => {
      captured.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'captured-element-dirty-write-does-not-taint-replaced-safe-slot',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{
      run() {
        shared.mockReturnValue('not reached');
      },
    }]);
    const captured = rest[0];
    rest[0] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('keeps a detached captured object separate from the replacement slot', () => {
      captured.run = () => shared.mockReturnValue('detached');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'conditional-slot-replacement-does-not-definitely-invalidate-capture',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    if (replace()) rest[0] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('retains the possible shared identity after conditional replacement', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'captured-element-invalidation-follows-container-alias',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    const arrayAlias = rest;
    arrayAlias[0] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invalidates a capture when an alias replaces its source slot', () => {
      captured.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'captured-element-invalidation-resolves-constant-computed-slot',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    const key = 0;
    rest[key] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('invalidates a capture through a constant computed slot', () => {
      captured.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'captured-element-invalidation-resolves-constant-key-alias',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const key = 0;
    const keyAlias = key;
    rest[keyAlias] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('resolves transitive constant computed keys', () => {
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-uses-reaching-assignment',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [
      {
        run() {
          shared.mockReturnValue('leaked');
        },
      },
      { run() {} },
    ]);
    const captured = rest[0];
    let key = 0;
    key = 1;
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('does not invalidate a different slot from a stale key initializer', () => {
      captured.run = () => shared.mockReturnValue('still leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-update',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    let key = 0;
    key++;
    rest[key] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('treats an updated computed key conservatively', () => {
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-for-of-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    let key = 0;
    for (key of [1]) {}
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('does not invalidate a capture using a pre-loop key value', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-for-in-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    let key = 0;
    for (key in { 1: true }) {}
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('does not invalidate a capture using a pre-loop property key', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-var-for-of-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    var key = 0;
    for (var key of [1]) {}
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('treats a var loop declaration as a function-scoped write', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-var-for-in-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    var key = 0;
    for (var key in { 1: true }) {}
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('treats a var property loop declaration as a function-scoped write', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-ordinary-var-for-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    var key = 0;
    for (var key = 1; false;) {}
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('treats an ordinary var loop initializer as a write', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-rejects-stale-value-after-var-redeclaration',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    var key = 0;
    var key = 1;
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('treats a later var initializer as a write to the same binding', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-key-resolves-lexical-loop-shadow',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{
      run() {
        shared.mockReturnValue('leaked');
      },
    }, { run() {} }]);
    let key = 0;
    for (const key of [1]) {
      rest[key] = { run() {} };
      beforeEach(vi.clearAllMocks);
      it('does not clear a dirty slot through an outer same-name key', () => {
        rest[0].run();
        expect(runSystem()).toBe(true);
      });
    }
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-parameter-default-does-not-override-call-argument',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    function install(key = 0) {
      rest[key] = {
        run() {
          shared.mockReturnValue('leaked');
        },
      };
    }
    install(1);
    beforeEach(vi.clearAllMocks);
    it('treats a parameter key as runtime-dependent', () => {
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-later-var-parameter-redeclaration-is-not-retroactive',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    function install(key = 0) {
      rest[key] = {
        run() {
          shared.mockReturnValue('leaked');
        },
      };
      var key = 1;
    }
    install(0);
    beforeEach(vi.clearAllMocks);
    it('does not apply a later var initializer to an earlier access', () => {
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-hoisted-var-initializer-is-not-retroactive',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    const captured = rest[0];
    rest[key] = { run() {} };
    var key = 0;
    beforeEach(vi.clearAllMocks);
    it('does not apply a hoisted var initializer before it executes', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-parameter-var-loop-write-invalidates-proven-value',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    function install(key) {
      key = 0;
      for (var key of [1]) {}
      rest[key] = {
        run() {
          shared.mockReturnValue('leaked');
        },
      };
    }
    install();
    beforeEach(vi.clearAllMocks);
    it('does not retain a pre-loop assignment to a parameter-var binding', () => {
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'computed-slot-parameter-var-initializer-invalidates-proven-value',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    function install(key) {
      key = 0;
      var key = 1;
      rest[key] = {
        run() {
          shared.mockReturnValue('leaked');
        },
      };
    }
    install();
    beforeEach(vi.clearAllMocks);
    it('does not retain an assignment across a parameter-var initializer', () => {
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'function-var-loop-write-does-not-poison-later-block-let',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    var key = 0;
    for (var key of [1]) {}
    {
      let key = 1;
      rest[key] = {
        run() {
          shared.mockReturnValue('not called');
        },
      };
      beforeEach(vi.clearAllMocks);
      it('keeps the later block-scoped key independent', () => {
        rest[0].run();
        expect(runSystem()).toBe(true);
      });
    }
  `,
);
assertRegressionFixture(
  'computed-slot-safe-write-after-compound-key-does-not-clear-dirty-slot',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{
      run() {
        shared.mockReturnValue('leaked');
      },
    }, { run() {} }]);
    let key = 0;
    key += 1;
    rest[key] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('does not use a stale key initializer to clear another slot', () => {
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'conditional-computed-slot-write-remains-possible',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }, { run() {} }]);
    let key = 0;
    if (chooseAnotherSlot()) key = 1;
    rest[key] = {
      run() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('retains every possible target of a conditional computed key', () => {
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'conditional-captured-identity-restoration-remains-possible',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    rest[0] = { run() {} };
    if (restoreCaptured()) rest[0] = captured;
    beforeEach(vi.clearAllMocks);
    it('keeps a conditionally restored capture as a possible slot identity', () => {
      captured.run = () => shared.mockReturnValue('leaked');
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'captured-dirty-element-survives-later-source-slot-replacement',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{
      run() {
        shared.mockReturnValue('leaked');
      },
    }]);
    const captured = rest[0];
    rest[0] = { run() {} };
    beforeEach(vi.clearAllMocks);
    it('keeps the captured object value frozen at capture time', () => {
      captured.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'captured-safe-element-ignores-later-dirty-slot-replacement',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{ run() {} }]);
    const captured = rest[0];
    rest[0] = {
      run() {
        shared.mockReturnValue('not reached');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('does not apply a later source-slot replacement retroactively', () => {
      captured.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'captured-element-restored-to-slot-shares-safe-member-write',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [{
      run() {
        shared.mockReturnValue('not reached');
      },
    }]);
    const captured = rest[0];
    rest[0] = { run() {} };
    rest[0] = captured;
    beforeEach(vi.clearAllMocks);
    it('recognizes restoration of the captured object to its slot', () => {
      captured.run = () => {};
      rest[0].run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'conditional-projected-safe-write-cannot-clear-dirty-target',
  `
    const shared = vi.fn();
    let rest;
    let other;
    ({ ...rest } = {
      nested: {
        run() {
          shared.mockReturnValue('leaked');
        },
      },
    });
    ({ ...other } = { nested: { run() {} } });
    let alias = rest;
    if (flag()) alias = other;
    beforeEach(vi.clearAllMocks);
    it('requires must-alias before a projected safe clear', () => {
      alias.nested = { run() {} };
      rest.nested.run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'array-rest-copy-slot-write-does-not-clear-source-risk',
  `
    const shared = vi.fn();
    let rest;
    ([...rest] = [
      { run() {} },
      {
        run() {
          shared.mockReturnValue('leaked');
        },
      },
    ]);
    const [skip, ...tail] = rest;
    beforeEach(vi.clearAllMocks);
    it('keeps copied-container slot replacement local', () => {
      tail[0] = { run() {} };
      rest[1].run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned rest helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'safe-overwrite-clears-object-rest-assignment-risk',
  `
    const shared = vi.fn();
    let rest;
    ({ ...rest } = {
      run() {
        shared.mockReturnValue('not reached');
      },
    });
    rest = { run() {} };
    it('uses the later unconditional safe overwrite', () => {
      rest.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'transitive-assignment-created-helper-override',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('follows transitive dominating helper assignments', () => {
      let first;
      let second;
      first = leak;
      second = first;
      second();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'conditional-assignment-created-helper-fails-closed',
  `
    const shared = vi.fn();
    function safe() {}
    function leak() {
      shared.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('does not trust a conditional helper assignment', () => {
      let run = safe;
      if (useLeak()) run = leak;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'conditional-distinct-factory-closure-helper-fails-closed',
  `
    const shared = vi.fn();
    function make(mock) {
      return {
        run() {
          mock.mockReturnValue('leaked');
        },
      };
    }
    const leaky = make(shared);
    const safe = make(vi.fn());
    beforeEach(vi.clearAllMocks);
    it('distinguishes closure environments for one helper AST', () => {
      let run = leaky.run;
      if (useSafe()) run = safe.run;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'conditional-distinct-harmless-helper-callbacks-remain-clean',
  `
    function first() {}
    function second() {}
    it('permits ambiguous callbacks with no mock mutation', () => {
      let run = first;
      if (useSecond()) run = second;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'conditional-distinct-local-factory-callbacks-remain-clean',
  `
    function make(mock) {
      return () => mock.mockReturnValue('local');
    }
    const first = make(vi.fn());
    const second = make(vi.fn());
    it('selects between callbacks over fresh local mocks', () => {
      let run = first;
      if (useSecond()) run = second;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'conditional-test-local-alias-factory-callbacks-remain-clean',
  `
    function make(mock) {
      return () => mock.mockReturnValue('local');
    }
    it('selects between callbacks over aliased test-local mocks', () => {
      const firstMock = vi.fn();
      const secondMock = vi.fn();
      const first = make(firstMock);
      const second = make(secondMock);
      let run = first;
      if (useSecond()) run = second;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'conditional-destructured-test-local-factory-callbacks-remain-clean',
  `
    function make(mock) {
      return () => mock.mockReturnValue('local');
    }
    it('selects between callbacks over destructured test-local mocks', () => {
      const [firstMock, secondMock] = [vi.fn(), vi.fn()];
      const first = make(firstMock);
      const second = make(secondMock);
      let run = first;
      if (useSecond()) run = second;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-dynamic-import-then-selector-remains-clean',
  `
    let run;
    run = await import('node:path').then((module) => module.resolve);
    it('permits a pure imported callable selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-dynamic-import-block-temp-selector-remains-clean',
  `
    const run = await import('node:path').then((module) => {
      const selected = module.resolve;
      return selected;
    });
    it('permits a side-effect-free imported temp selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-dynamic-import-block-destructured-temp-selector-remains-clean',
  `
    const run = await import('node:path').then((module) => {
      const { resolve } = module;
      return resolve;
    });
    it('permits a side-effect-free destructured imported temp selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-dynamic-import-literal-element-selector-remains-clean',
  `
    const run = await import('node:path').then((module) => module['resolve']);
    it('permits a literal imported selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-dynamic-import-template-element-selector-remains-clean',
  `
    const run = await import('node:path').then((module) => module[\`resolve\`]);
    it('permits a no-substitution template imported selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'pure-direct-dynamic-import-literal-selector-remains-clean',
  `
    const run = (await import('node:path'))['resolve'];
    it('permits a direct literal imported selector', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dynamic-import-block-selector-side-effect-fails-closed',
  `
    const shared = vi.fn();
    let run;
    run = await import('node:path').then((module) => {
      const ignored = shared.mockReturnValue('leaked');
      return module.resolve;
    });
    beforeEach(vi.clearAllMocks);
    it('does not exempt selector side effects', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'dynamic-import-computed-selector-side-effect-fails-closed',
  `
    const shared = vi.fn();
    const run = await import('node:path').then(
      (module) => module[(shared.mockReturnValue('leaked'), 'resolve')]
    );
    beforeEach(vi.clearAllMocks);
    it('does not exempt computed selector side effects', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'direct-dynamic-import-computed-selector-side-effect-fails-closed',
  `
    const shared = vi.fn();
    const run = (await import('node:path'))[
      (shared.mockReturnValue('leaked'), 'resolve')
    ];
    beforeEach(vi.clearAllMocks);
    it('does not exempt direct computed selector side effects', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'dynamic-import-parameter-default-side-effect-fails-closed',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
      return () => {};
    }
    const run = await import('node:path').then(
      ({ missing = leak() }) => missing
    );
    beforeEach(vi.clearAllMocks);
    it('does not exempt selector binding defaults', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'mixed-dynamic-import-and-local-helper-assignment-fails-closed',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    let run;
    run = useLeak() ? leak : (await import('node:path')).resolve;
    beforeEach(vi.clearAllMocks);
    it('does not exempt a mixed dynamic-import assignment', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'dynamic-import-destructuring-default-helper-fails-closed',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    const { missing: run = leak } = await import('node:path');
    beforeEach(vi.clearAllMocks);
    it('does not exempt a local default on dynamic import destructuring', () => {
      run();
      expect(runSystem()).toBe(true);
    });
  `,
  'assigned helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'module-assigned-helper-after-test-registration',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('leaked');
    }
    let run;
    beforeEach(vi.clearAllMocks);
    it('observes module assignments before callback execution', () => {
      run();
      expect(runSystem()).toBe(true);
    });
    run = leak;
  `,
  'shared can carry a per-test implementation',
);
assertCleanRegressionFixture(
  'dominating-safe-helper-reassignment-remains-clean',
  `
    const shared = vi.fn();
    function leak() {
      shared.mockReturnValue('not reached');
    }
    function safe() {}
    beforeEach(vi.clearAllMocks);
    it('uses the later dominating safe helper', () => {
      let run = leak;
      run = safe;
      run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'callable-factory-helper-override',
  `
    const shared = vi.fn();
    function makeOverride(mock) {
      return () => mock.mockReturnValue('leaked');
    }
    const override = makeOverride(shared);
    beforeEach(vi.clearAllMocks);
    it('invokes a callable returned by a factory', () => {
      override();
      expect(runSystem()).toBe(true);
    });
  `,
  'shared can carry a per-test implementation',
);
assertRegressionFixture(
  'dynamic-computed-property-after-static-fails-closed',
  `
    const shared = vi.fn();
    let key = 'override';
    const helpers = {
      override() {},
      [key]() {
        shared.mockReturnValue('leaked');
      },
    };
    beforeEach(vi.clearAllMocks);
    it('cannot trust a later dynamic computed helper', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'computed helper property cannot be analyzed safely',
);
assertRegressionFixture(
  'dynamic-computed-named-function-after-static-fails-closed',
  `
    const shared = vi.fn();
    let key = 'override';
    function leak() {
      shared.mockReturnValue('leaked');
    }
    const helpers = {
      override() {},
      [key]: leak,
    };
    beforeEach(vi.clearAllMocks);
    it('cannot trust a later named computed helper', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
  'computed helper property cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'static-property-after-dynamic-computed-helper-wins',
  `
    let key = 'override';
    const helpers = {
      [key]() {
        throw new Error('not reached');
      },
      override() {},
    };
    it('uses the later static helper property', () => {
      helpers.override();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'dynamic-computed-non-callable-data-after-static-helper-remains-clean',
  `
    let key = 'metadata';
    const helpers = {
      run() {},
      [key]: { label: 'data' },
    };
    it('does not treat definitely non-callable data as a helper override', () => {
      helpers.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'dynamic-computed-primitive-data-after-static-helper-remains-clean',
  `
    let firstKey = 'first';
    let secondKey = 'second';
    let thirdKey = 'third';
    let fourthKey = 'fourth';
    const absent = undefined;
    const helpers = {
      run() {},
      [firstKey]: \`data-\${Date.now()}\`,
      [secondKey]: -1,
      [thirdKey]: 1n,
      [fourthKey]: absent,
    };
    it('does not treat primitive data as a helper override', () => {
      helpers.run();
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'dynamic-element-access-hook-helper-fails-closed',
  `
    const shared = vi.fn();
    const lifecycle = {
      clear() {
        vi.clearAllMocks();
      },
    };
    beforeEach(() => lifecycle[getHookKey()]());
    it('cannot safely summarize a dynamic hook helper', () => {
      shared.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'computed hook helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'factory-produced-dynamic-hook-helper-fails-closed',
  `
    const shared = vi.fn();
    const makeLifecycle = () => ({
      clear() {
        vi.clearAllMocks();
      },
    });
    const lifecycle = makeLifecycle();
    beforeEach(() => lifecycle[getHookKey()]());
    it('cannot safely summarize a factory-produced hook helper', () => {
      shared.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'computed hook helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'temp-return-factory-dynamic-hook-helper-fails-closed',
  `
    const shared = vi.fn();
    function makeLifecycle() {
      const value = {
        clear() {
          vi.clearAllMocks();
        },
      };
      return value;
    }
    const lifecycle = makeLifecycle();
    beforeEach(() => lifecycle[getHookKey()]());
    it('cannot safely summarize a temp-return hook helper', () => {
      shared.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'computed hook helper call cannot be analyzed safely',
);
assertSingleRegressionFixture(
  'dynamic-hook-helper-finding-is-deduplicated',
  `
    const lifecycle = {
      clear() {
        vi.clearAllMocks();
      },
    };
    beforeEach(() => lifecycle[getHookKey()]());
    it('first affected test', () => {
      expect(runSystem()).toBe(true);
    });
    it('second affected test', () => {
      expect(runOtherSystem()).toBe(true);
    });
  `,
  'computed hook helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-hook-helper-fails-closed',
  `
    const shared = vi.fn();
    function run(cleanup, again) {
      if (again) run(vi.clearAllMocks, false);
      else cleanup();
    }
    beforeEach(() => run(() => {}, true));
    it('cannot safely summarize recursive hook remapping', () => {
      shared.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive hook helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'direct-recursive-helper-fails-closed',
  `
    const shared = vi.fn();
    function recurse(mock) {
      if (keepGoing()) recurse(shared);
      else mock.mockReturnValue('leaked');
    }
    it('invokes a recursive helper', () => {
      recurse(vi.fn());
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-unknown-call-argument-fails-closed',
  `
    const shared = vi.fn();
    function selectShared() {
      return shared;
    }
    function recurse(mock, again) {
      if (again) recurse(selectShared(), false);
      else mock.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('cannot prove a recursive remapping stays local', () => {
      recurse(vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-parameter-alias-fails-closed',
  `
    const shared = vi.fn();
    function selectShared() {
      return shared;
    }
    function recurse(mock, again) {
      const alias = mock;
      if (again) recurse(selectShared(), false);
      else alias.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('cannot hide recursive remapping behind a parameter alias', () => {
      recurse(vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-delegated-parameter-mutation-fails-closed',
  `
    const shared = vi.fn();
    function selectShared() {
      return shared;
    }
    function configure(mock) {
      mock.mockReturnValue('leaked');
    }
    function recurse(mock, again) {
      if (again) recurse(selectShared(), false);
      else configure(mock);
    }
    beforeEach(vi.clearAllMocks);
    it('cannot hide recursive remapping behind a delegated mutation', () => {
      recurse(vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'recursive-helper-proven-local-mock-remains-clean',
  `
    function configure(mock, remaining) {
      if (remaining > 0) configure(mock, remaining - 1);
      else mock.mockReturnValue('local');
    }
    it('recursively configures only a fresh local mock', () => {
      const local = vi.fn();
      configure(local, 1);
      expect(local()).toBe('local');
    });
  `,
);
assertRegressionFixture(
  'recursive-helper-property-parameter-fails-closed',
  `
    const shared = vi.fn();
    function recurse(holder, again) {
      if (again) recurse({ mock: shared }, false);
      else holder.mock.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('tracks a mutated property to its recursive parameter', () => {
      recurse({ mock: vi.fn() }, true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-destructured-parameter-fails-closed',
  `
    const shared = vi.fn();
    function recurse({ mock }, again) {
      if (again) recurse({ mock: shared }, false);
      else mock.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('tracks a destructured recursive parameter', () => {
      recurse({ mock: vi.fn() }, true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-object-method-delegation-fails-closed',
  `
    const shared = vi.fn();
    const mutators = {
      configure(mock) {
        mock.mockReturnValue('leaked');
      },
    };
    function selectShared() {
      return shared;
    }
    function recurse(mock, again) {
      if (again) recurse(selectShared(), false);
      else mutators.configure(mock);
    }
    beforeEach(vi.clearAllMocks);
    it('tracks delegated object-method mutation', () => {
      recurse(vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertCleanRegressionFixture(
  'recursive-helper-proven-local-property-remains-clean',
  `
    function configure(mock, remaining) {
      if (remaining > 0) configure(mock, remaining - 1);
      else mock.mockReturnValue('local');
    }
    it('recursively configures a fresh local property', () => {
      const local = { mock: vi.fn() };
      configure(local.mock, 1);
      expect(local.mock()).toBe('local');
    });
  `,
);
assertCleanRegressionFixture(
  'recursive-helper-proven-local-structured-property-remains-clean',
  `
    function recurse(holder, remaining) {
      if (remaining > 0) recurse({ mock: vi.fn() }, remaining - 1);
      else holder.mock.mockReturnValue('local');
    }
    it('recursively configures a fresh structured local property', () => {
      recurse({ mock: vi.fn() }, 1);
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'recursive-helper-local-alias-to-shared-property-fails-closed',
  `
    const sharedHolder = { mock: vi.fn() };
    function recurse(mock, again) {
      if (again) {
        const local = sharedHolder;
        recurse(local.mock, false);
      } else mock.mockReturnValue('leaked');
    }
    beforeEach(vi.clearAllMocks);
    it('does not certify a local alias to shared storage', () => {
      recurse(vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'recursive-helper-parameter-object-method-delegation-fails-closed',
  `
    const shared = vi.fn();
    const mutators = {
      configure(mock) {
        mock.mockReturnValue('leaked');
      },
    };
    function recurse(ops, mock, again) {
      if (again) recurse(ops, shared, false);
      else ops.configure(mock);
    }
    beforeEach(vi.clearAllMocks);
    it('tracks delegated mutation through a parameter object', () => {
      recurse(mutators, vi.fn(), true);
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'mutually-recursive-helper-fails-closed',
  `
    const shared = vi.fn();
    function first(mock) {
      second(mock);
    }
    function second(mock) {
      if (keepGoing()) first(shared);
      else mock.mockReturnValue('leaked');
    }
    it('invokes mutually recursive helpers', () => {
      first(vi.fn());
      expect(runSystem()).toBe(true);
    });
  `,
  'recursive helper call cannot be analyzed safely',
);
assertRegressionFixture(
  'parameter-dispatched-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    function invoke(helpers) {
      helpers.override();
    }
    beforeEach(vi.clearAllMocks);
    it('passes an object helper through a parameter', () => {
      invoke({
        override() {
          sharedMock.mockReturnValue('leaked');
        },
      });
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'nested-parameter-dispatched-object-method-helper-override',
  `
    const sharedMock = vi.fn();
    function invoke(wrapper) {
      wrapper.helpers.override();
    }
    beforeEach(vi.clearAllMocks);
    it('passes a nested object helper through a parameter', () => {
      invoke({
        helpers: {
          override() {
            sharedMock.mockReturnValue('leaked');
          },
        },
      });
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertCleanRegressionFixture(
  'dead-helper-shared-mock-override-remains-ignored',
  `
    const sharedMock = vi.fn();
    beforeEach(vi.clearAllMocks);
    function unusedOverride() {
      sharedMock.mockReturnValue('not executed');
    }
    it('does not invoke the helper', () => {
      expect(runSystem()).toBe(true);
    });
  `,
);
assertRegressionFixture(
  'logical-assertion-does-not-dominate-later-return',
  `
    it('does not count a short-circuited assertion', () => {
      shouldAssert() && expect(runSystem()).toBe(true);
      if (skipTest()) return;
    });
  `,
  'test can return before its first assertion',
);
assertRegressionFixture(
  'ternary-returned-assertion-is-not-guaranteed',
  `
    it('does not count a conditional returned assertion', () => {
      return shouldAssert() ? expect(runSystem()).toBe(true) : undefined;
    });
  `,
  'test can return before its first assertion',
);
assertCleanRegressionFixture(
  'same-branch-assertion-dominates-return',
  `
    it('asserts before returning on the same branch', () => {
      if (shouldReturn()) {
        expect(runSystem()).toBe(true);
        return;
      }
      expect(runOtherSystem()).toBe(true);
    });
  `,
);
assertCleanRegressionFixture(
  'shared-spy-with-restoration',
  `
    const service = { read: () => 'original' };
    afterEach(() => vi.restoreAllMocks());
    it('overrides a shared service safely', () => {
      vi.spyOn(service, 'read').mockReturnValue('isolated');
      expect(service.read()).toBe('isolated');
    });
  `,
);
assertRegressionFixture(
  'alias-consumer',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(() => vi.clearAllMocks());
    it('overrides the shared property', () => {
      mocks.rpc.mockResolvedValue('leaked');
    });
    it('consumes through an alias', async () => {
      const { rpc } = mocks;
      expect(await rpc()).toBeUndefined();
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'simple-shared-mock-alias-override',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('overrides through a local alias', () => {
      const rpc = mocks.rpc;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'destructured-shared-mock-alias-override',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('overrides through a destructured local alias', () => {
      const { rpc } = mocks;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'transitive-shared-mock-alias-override',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('overrides through two local aliases', () => {
      const first = mocks.rpc;
      const second = first;
      second.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'nested-destructured-shared-mock-alias-override',
  `
    const mocks = { nested: { rpc: vi.fn() } };
    beforeEach(vi.clearAllMocks);
    it('overrides through nested destructuring', () => {
      const { nested: { rpc } } = mocks;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'array-destructured-shared-mock-alias-override',
  `
    const mocks = [vi.fn()];
    beforeEach(vi.clearAllMocks);
    it('overrides through array destructuring', () => {
      const [rpc] = mocks;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'assignment-created-shared-mock-alias-override',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('overrides through an assigned alias', () => {
      let rpc;
      rpc = mocks.rpc;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'conditional-local-reassignment-preserves-shared-alias-path',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('may retain the shared alias', () => {
      let rpc = mocks.rpc;
      if (useLocal()) rpc = vi.fn();
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'logical-and-reassignment-preserves-shared-alias-path',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('may skip an AND reassignment', () => {
      let rpc = mocks.rpc;
      useLocal() && (rpc = vi.fn());
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'logical-or-reassignment-preserves-shared-alias-path',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('may skip an OR reassignment', () => {
      let rpc = mocks.rpc;
      useLocal() || (rpc = vi.fn());
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'ternary-reassignment-preserves-shared-alias-path',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('may take the other ternary branch', () => {
      let rpc = mocks.rpc;
      useLocal() ? (rpc = vi.fn()) : runOtherBranch();
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'conditional-shared-reassignment-adds-shared-alias-path',
  `
    const mocks = { rpc: vi.fn() };
    beforeEach(vi.clearAllMocks);
    it('may select the shared alias', () => {
      let rpc = vi.fn();
      if (useShared()) rpc = mocks.rpc;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'can carry a per-test implementation into another test',
);
assertRegressionFixture(
  'conditional-distinct-shared-aliases-require-all-targets-protected',
  `
    const mocks = { safe: vi.fn(), leaky: vi.fn() };
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.safe.mockReset();
    });
    it('may select the unprotected shared target', () => {
      let rpc = mocks.safe;
      if (useOther()) rpc = mocks.leaky;
      rpc.mockReturnValue('leaked');
      expect(runSystem()).toBe(true);
    });
  `,
  'mocks.leaky can carry a per-test implementation',
);
assertRegressionFixture(
  'sibling-property-assignment-does-not-refresh-mock',
  `
    const mocks = { rpc: vi.fn(), other: 0 };
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.other = 1;
    });
    it('overrides an unrefreshed sibling mock', () => {
      mocks.rpc.mockResolvedValue('leaked');
    });
  `,
  'can carry a per-test implementation into another test',
);

const findings = [];
for (const file of collectTestFiles(packagesRoot)) {
  for (const issue of auditFile(file)) findings.push({ file, ...issue });
}

if (findings.length > 0) {
  console.error(`Test-integrity audit found ${findings.length} issue(s):`);
  for (const finding of findings) {
    console.error(
      `${path.relative(repoRoot, finding.file)}:${finding.line}: ${finding.message}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log('Test-integrity audit passed: no mock leaks, assertion-free early returns, or input-only expectations found.');
}
