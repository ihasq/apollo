import OpenAI from 'openai';

// --- ファイルとディレクトリの処理 ---

/**
 * ディレクトリを再帰的にスキャンしてファイルと依存関係を処理します。
 * @param {FileSystemDirectoryHandle} dirHandle 現在のディレクトリハンドル。
 * @param {string} currentPath 現在のパス。
 * @param {string} parentId 親ノードのMermaid ID。
 */
async function scanDirectory(dirHandle, currentPath, parentId) {
  for await (const entry of dirHandle.values()) {
    const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const entryId = getUniqueId();
    nodeMap.set(entryPath, { id: entryId, name: entry.name });

    mermaidLines.push(`    ${parentId} -- / --> ${entryId}["${entry.name}"]`);

    if (entry.kind === 'directory') {
      await scanDirectory(entry, entryPath, entryId);
    } else if (entry.kind === 'file') {
      await processFile(entry, entryPath);
    }
  }
}

/**
 * ファイルを処理し、内容を解析します。
 * @param {FileSystemFileHandle} fileHandle ファイルハンドル。
 * @param {string} filePath ファイルのパス。
 */
async function processFile(fileHandle, filePath) {
  const file = await fileHandle.getFile();

  if (filePath.endsWith('.js') || filePath.endsWith('.ts') || filePath.endsWith('.mjs')) {
    const content = await file.text();
    try {
      const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
      for (const node of ast.body) {
        if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
          const targetPath = resolvePath(filePath, node.source.value);
          const label = formatSpecifiers(node);
          if (label) {
            dependencies.push({ from: filePath, to: targetPath, label });
          }
        }
      }
    } catch (e) {
      console.warn(`[Acorn Parse Error] Failed to parse ${filePath}:`, e.message);
    }
  } else if (fileHandle.name === 'package.json') {
    try {
      const content = await file.text();
      const pkg = JSON.parse(content);
      if (typeof pkg.exports === 'string') {
        packageExportsTarget = pkg.exports.replace('./', '');
      }
    } catch (e) {
      console.warn(`Failed to parse package.json:`, e.message);
    }
  }
}

/**
 * 現在のパスと相対パスから新しい絶対パスを解決します。
 * @param {string} basePath 現在のファイルのパス。
 * @param {string} relativePath インポート/エクスポート元の相対パス。
 * @returns {string} ルートからの絶対パス。
 */
function resolvePath(basePath, relativePath) {
  const baseParts = basePath.split('/').slice(0, -1);
  const relativeParts = relativePath.split('/');
  const newPathParts = [...baseParts];

  for (const part of relativeParts) {
    if (part === '..') {
      newPathParts.pop();
    } else if (part !== '.') {
      newPathParts.push(part);
    }
  }
  // .js拡張子がない場合、追加する（簡易的な解決策）
  let resolved = newPathParts.join('/');
  if (!/\.(js|ts|mjs|json)$/.test(resolved) && relativePath.startsWith('.')) {
      resolved += '.js';
  }
  return resolved;
}

/**
 * AcornのASTノードからエクスポート指定子の文字列をフォーマットします。
 * @param {object} node AcornのASTノード。
 * @returns {string | null} Mermaidの矢印につけるラベル文字列。
 */
function formatSpecifiers(node) {
  if (node.type === 'ExportAllDeclaration' && !node.exported) {
    return '{ * }';
  }
  if (!node.specifiers || node.specifiers.length === 0) {
    return null;
  }
  const parts = node.specifiers.map(spec => {
    if (spec.local.name === spec.exported.name) {
      return spec.local.name;
    }
    return `${spec.local.name} as ${spec.exported.name}`;
  });
  return `{ ${parts.join(', ')} }`;
}

/**
 * FileSystemDirectoryHandleからディレクトリ構造とJS/TSの依存関係を解析し、
 * Mermaidのフローチャート文字列を生成します。
 *
 * @param {FileSystemDirectoryHandle} directoryHandle 解析対象のルートディレクトリハンドル。
 * @returns {Promise<string>} Mermaidフローチャート形式の文字列。
 * 
 * @AWD_00 [depends nothing.]
 * @AWD_01 [collar-regex]
 */
async function generateDependencyMermaid(directoryHandle) {
  // --- 初期化 ---
  const mermaidLines = ['flowchart TD'];
  const nodeMap = new Map(); // path -> { id, name }
  const dependencies = [];
  let packageExportsTarget = null;
  let nodeIdCounter = 0;

  const getUniqueId = () => `n${++nodeIdCounter}`;

  // --- ヘルパー関数 ---

  // --- メイン処理 ---

  // 1. ルートノードを作成
  const rootId = getUniqueId();
  mermaidLines.push(`    ${rootId}["directory root"]`);
  nodeMap.set('.', { id: rootId, name: 'directory root' });

  // 2. ディレクトリ構造をスキャン
  await scanDirectory(directoryHandle, '', rootId);

  // 3. 依存関係のエッジを追加
  for (const dep of dependencies) {
    // 依存の向きは `export from` の向きと逆になる
    const fromNode = nodeMap.get(dep.to);
    const toNode = nodeMap.get(dep.from);
    if (fromNode && toNode) {
      mermaidLines.push(`    ${fromNode.id} -- ${dep.label} --> ${toNode.id}`);
    }
  }

  // 4. package.json の "exports" のエッジを追加
  let exportRootId;
  if (packageExportsTarget) {
    const sourceNode = nodeMap.get(packageExportsTarget);
    if (sourceNode) {
      exportRootId = getUniqueId();
      mermaidLines.push(`    ${exportRootId}["export root"]`);
      mermaidLines.push(`    ${sourceNode.id} --> ${exportRootId}`);
    }
  }
  
  // 5. 例で示された特殊なノード形状を追加
  // 注意: この `@{...}` 構文は標準のMermaidではサポートされていません。
  //       これはカスタムレンダラでのみ機能する可能性があります。
  mermaidLines.push(`\n    ${rootId}@{ shape: fr-circ }`);
  if(exportRootId) {
    mermaidLines.push(`    ${exportRootId}@{ shape: f-circ }`);
  }

  return mermaidLines.join('\n');
}