// A real VS Code browser-extension fixture. No AfterEdit API is used here.
const vscode = require('vscode');
exports.activate = function(context) {
 context.subscriptions.push(vscode.commands.registerCommand('afteredit.fixture.activation', () => 'VS Code extension activated successfully'));
 context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider('plaintext', {
  provideDocumentFormattingEdits(document) {
   const end = document.positionAt(document.getText().length);
   return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(0,0),end),document.getText().toUpperCase())];
  }
 }));
 context.subscriptions.push(vscode.commands.registerCommand('afteredit.fixture.format', async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('Open a plain-text document first');
  const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider',editor.document.uri,{tabSize:2,insertSpaces:true});
  if (!edits || !edits.length) throw new Error('Formatter provider returned no edits');
  const applied = await editor.edit(builder => edits.forEach(edit => builder.replace(edit.range,edit.newText)));
  if (!applied) throw new Error('Edit was not applied');
  return 'Formatter provider applied uppercase text';
 }));
};
exports.deactivate = function() {};
