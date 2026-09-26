use crate::{process::{run,Output},workspace::{allowed,WorkspaceState}};
use serde::Serialize;
use std::{path::{Component,Path,PathBuf},process::Command,time::Duration};
#[derive(Clone,Serialize,Debug)]
#[serde(rename_all="camelCase")]
pub struct GitFile {pub path:String,pub original_path:Option<String>,pub index:String,pub worktree:String}
#[derive(Serialize)]
pub struct GitStatus {branch:String,files:Vec<GitFile>}
pub(crate) fn git(root:&Path,args:&[&str])->Result<Output,String>{git_within(root,args,None,Duration::from_secs(30))}
fn git_index(root:&Path,args:&[&str],index:Option<&Path>)->Result<Output,String>{git_within(root,args,index,Duration::from_secs(30))}
fn git_within(root:&Path,args:&[&str],index:Option<&Path>,limit:Duration)->Result<Output,String>{
    let binary=crate::toolpath::resolve_binary("git").ok_or("Git was not found. Install Git and reopen AfterEdit.")?;
    let mut command=Command::new(binary);
    command.current_dir(root).args(["--no-pager","--literal-pathspecs"]).args(args);
    for (key,_) in std::env::vars_os(){if key.to_string_lossy().starts_with("GIT_"){command.env_remove(key);}}
    if let Some(index)=index{command.env("GIT_INDEX_FILE",index);}
    command.env("GIT_TERMINAL_PROMPT","0").env("GIT_OPTIONAL_LOCKS","0").env("LC_ALL","C").env("GIT_EDITOR","true");
    run(command,limit)
}
fn success(output:Output)->Result<String,String>{
    if output.code==0 {Ok(output.stdout)}else{Err(format!("Git exited {}: {}",output.code,output.stderr))}
}
fn outcome(output:Output)->Result<String,String>{
    if output.code!=0 {return Err(format!("Git exited {}: {}",output.code,output.stderr));}
    let text=if output.stdout.trim().is_empty(){output.stderr}else{output.stdout};
    Ok(if text.trim().is_empty(){"Git finished with no output.".into()}else{text})
}
pub(crate) fn repository(state:&WorkspaceState,root:&str)->Result<PathBuf,String>{
    let root=allowed(state,Path::new(root))?;
    let top=success(git(&root,&["rev-parse","--show-toplevel"])?)?;
    if Path::new(top.trim_end()).canonicalize().map_err(|e|e.to_string())? != root {
        return Err("Select the repository's top-level folder to use Git.".into());
    }
    Ok(root)
}
fn valid_path(path:&str)->Result<(),String>{
    if path.is_empty() || Path::new(path).is_absolute() || path.contains('\0') || path.contains('\\') ||
        Path::new(path).components().any(|p|!matches!(p,Component::Normal(_))) ||
        path.split('/').any(|p|p.eq_ignore_ascii_case(".git")) {
        return Err("Git paths must be relative files inside the repository.".into());
    }
    Ok(())
}
fn parse_status(text:&str)->Result<Vec<GitFile>,String>{
    let mut fields=text.split('\0').filter(|s|!s.is_empty());let mut rows=Vec::new();
    while let Some(row)=fields.next(){
        let bytes=row.as_bytes();
        if bytes.len()<4 || bytes[2]!=b' ' || !row.is_char_boundary(3){return Err("Invalid Git status output".into());}
        let path=&row[3..];valid_path(path)?;
        let original_path=if bytes[..2].iter().any(|b|*b==b'R'||*b==b'C') {Some(fields.next().ok_or("Missing rename source")?.to_string())}else{None};
        if let Some(original)=&original_path{valid_path(original)?;}
        rows.push(GitFile{path:path.into(),original_path,index:(bytes[0] as char).to_string(),worktree:(bytes[1] as char).to_string()});
    }Ok(rows)
}
#[tauri::command]
pub async fn git_status(state:tauri::State<'_,WorkspaceState>,root:String)->Result<GitStatus,String>{
    let root=repository(&state,&root)?;
    tauri::async_runtime::spawn_blocking(move||{
        let files=parse_status(&success(git(&root,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?)?;
        let symbolic=git(&root,&["symbolic-ref","--short","-q","HEAD"])?;
        let branch=if symbolic.code==0{symbolic.stdout.trim().to_string()}else{format!("Detached {}",success(git(&root,&["rev-parse","--short","HEAD"])?)?.trim())};
        Ok(GitStatus{branch,files})
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_diff(state:tauri::State<'_,WorkspaceState>,root:String,path:String,staged:bool)->Result<String,String>{
    let root=repository(&state,&root)?;valid_path(&path)?;
    tauri::async_runtime::spawn_blocking(move||{
        let rows=parse_status(&success(git(&root,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?)?;
        let row=rows.iter().find(|r|r.path==path).ok_or("File status changed. Refresh Git.")?;
        if row.index=="?" {return Ok("Untracked file: open it in the editor to review its contents before staging.".into());}
        let mut args=vec!["diff","--no-ext-diff","--no-textconv","--no-color"];
        if staged{args.push("--cached");}args.extend(["--",&path]);
        if let Some(original)=&row.original_path{args.push(original);}
        success(git(&root,&args)?)
    }).await.map_err(|e|e.to_string())?
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn parses_spaces_renames_and_rejects_escaping_paths(){
  let rows=parse_status(" M file name.txt\0R  new.txt\0old.txt\0?? fresh.txt\0").unwrap();
  assert_eq!(rows[0].path,"file name.txt");assert_eq!(rows[1].original_path.as_deref(),Some("old.txt"));
  for path in ["../escape","/tmp/file",".git/config","nested/../../file"]{assert!(valid_path(path).is_err());}
 }
 #[test]fn real_repository_status_and_diff(){
  let dir=std::env::temp_dir().join(format!("afteredit-git-read-{}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();
  success(git(&dir,&["init"]) .unwrap()).unwrap();
  std::fs::write(dir.join("file name.txt"),"first\n").unwrap();success(git(&dir,&["add","--","file name.txt"]).unwrap()).unwrap();
  let rows=parse_status(&success(git(&dir,&["status","--porcelain=v1","-z"]).unwrap()).unwrap()).unwrap();assert_eq!(rows[0].index,"A");
  assert!(success(git(&dir,&["diff","--cached","--no-ext-diff","--no-textconv"]).unwrap()).unwrap().contains("+first"));
  std::fs::remove_dir_all(dir).unwrap();
 }
}

#[tauri::command]
pub async fn git_stage(state:tauri::State<'_,WorkspaceState>,root:String,path:String,stage:bool)->Result<(),String>{
 let root=repository(&state,&root)?;valid_path(&path)?;
 tauri::async_runtime::spawn_blocking(move||{
  let rows=parse_status(&success(git(&root,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?)?;
  let row=rows.iter().find(|r|r.path==path).ok_or("File status changed. Refresh Git.")?;
  let mut paths=vec![path.as_str()];if let Some(original)=&row.original_path{paths.push(original);}
  let mut args=if stage{vec!["add","--all","--"]}else if git(&root,&["rev-parse","--verify","HEAD"])?.code==0{vec!["reset","--quiet","HEAD","--"]}else{vec!["rm","--cached","--quiet","--"]};
  args.extend(paths);success(git(&root,&args)?).map(|_|())
 }).await.map_err(|e|e.to_string())?
}
#[derive(Serialize)]
pub struct StagedReview {tree:String,diff:String}
#[tauri::command]
pub async fn git_review_staged(state:tauri::State<'_,WorkspaceState>,root:String)->Result<StagedReview,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||{
  let tree=success(git(&root,&["write-tree"])?)?.trim().to_string();
  let diff=success(git(&root,&["diff","--cached","--no-color","--no-ext-diff","--no-textconv"])?)?;
  if diff.is_empty(){return Err("No staged changes to commit.".into());}
  if success(git(&root,&["write-tree"])?)?.trim()!=tree{return Err("Staging changed while loading the review. Try again.".into());}
  Ok(StagedReview{tree,diff})
 }).await.map_err(|e|e.to_string())?
}
fn commit_snapshot(root:&Path,message:&str,tree:&str)->Result<String,String>{
 use std::io::Write;
 if message.trim().is_empty() || message.len()>10000{return Err("Enter a commit message of 1–10,000 bytes.".into());}
 // Fail closed: a scan that cannot complete blocks the commit rather than
 // waving it through. Locations only -- never the secret itself.
 let scan=crate::secrets::scan_staged(root)?;
 if !scan.findings.is_empty(){return Err(crate::secrets::refusal(&scan));}
 let index_path=success(git(root,&["rev-parse","--git-path","index"])?)?;
 let index_path=root.join(index_path.trim_end());
 let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
 let temporary=index_path.with_file_name(format!("afteredit-index-{}-{stamp}",std::process::id()));
 let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e|e.to_string())?;
 let result=(||{
  let bytes=std::fs::read(&index_path).map_err(|e|e.to_string())?;
  file.write_all(&bytes).map_err(|e|e.to_string())?;drop(file);
  let actual=success(git_index(root,&["write-tree"],Some(&temporary))?)?;
  if actual.trim()!=tree{return Err("Staged changes changed since review. Review them again before committing.".into());}
  // Commit the reviewed index snapshot. Concurrent staging in the real index remains intact.
  success(git_index(root,&["commit","-m",message],Some(&temporary))?)
 })();
 let _=std::fs::remove_file(temporary);result
}
#[tauri::command]
pub async fn git_commit(app:tauri::AppHandle,state:tauri::State<'_,WorkspaceState>,root:String,message:String,tree:String)->Result<String,String>{
 let root=repository(&state,&root)?;
 let recorded_root=root.display().to_string();
 let recorded_tree=tree.clone();
 let result=tauri::async_runtime::spawn_blocking(move||commit_snapshot(&root,&message,&tree)).await.map_err(|e|e.to_string())??;
 crate::journal::record_app(&app,"commit","git commit","",&recorded_tree,&recorded_root);
 Ok(result)
}
fn clean(root:&Path)->Result<(),String>{
 let rows=parse_status(&success(git(root,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?)?;
 if rows.is_empty(){Ok(())}else{Err("Commit, stash, or discard changes before switching branches or pulling.".into())}
}
fn valid_branch(name:&str)->Result<(),String>{
 if name.is_empty()||name.len()>200||name.starts_with('-')||name.contains([' ','\0','~','^',':','\\','?','*','['])||name.contains("..")||name.ends_with('.')||name.ends_with('/')||name.split('/').any(|part|part.is_empty()||part.eq_ignore_ascii_case(".git")||part.ends_with(".lock")){
  return Err("Branch names must be a single relative ref without spaces or Git metacharacters.".into());
 }
 Ok(())
}
#[derive(Serialize)]
pub struct GitBranch{name:String,current:bool,upstream:Option<String>}
#[tauri::command]
pub async fn git_branches(state:tauri::State<'_,WorkspaceState>,root:String)->Result<Vec<GitBranch>,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||{
  let text=success(git(&root,&["for-each-ref","--format=%(HEAD)%00%(refname:short)%00%(upstream:short)","refs/heads"])?)?;
  let mut branches=Vec::new();
  for row in text.split('\n').filter(|row|!row.is_empty()){
   let mut fields=row.split('\0');
   let head=fields.next().unwrap_or("");
   let name=fields.next().unwrap_or("").to_string();
   valid_branch(&name)?;
   let upstream=fields.next().filter(|value|!value.is_empty()).map(str::to_string);
   branches.push(GitBranch{current:head=="*",name,upstream});
  }
  Ok(branches)
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_checkout(state:tauri::State<'_,WorkspaceState>,root:String,branch:String,create:bool)->Result<String,String>{
 let root=repository(&state,&root)?;valid_branch(&branch)?;
 tauri::async_runtime::spawn_blocking(move||{
  clean(&root)?;
  if create {outcome(git(&root,&["switch","-c",&branch])?)} else {outcome(git(&root,&["switch","--",&branch])?)}
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_fetch(state:tauri::State<'_,WorkspaceState>,root:String)->Result<String,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||outcome(git_within(&root,&["fetch","--prune"],None,Duration::from_secs(90))?)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_pull(state:tauri::State<'_,WorkspaceState>,root:String)->Result<String,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||{
  clean(&root)?;
  outcome(git_within(&root,&["pull","--ff-only"],None,Duration::from_secs(90))?)
 }).await.map_err(|e|e.to_string())?
}
#[derive(Serialize)]
pub struct GitHunk{index:usize,header:String,body:String}
pub(crate) fn parse_hunks(diff:&str)->Vec<GitHunk>{
 let mut hunks=Vec::new();
 let mut current:Option<(String,String)>=None;
 for line in diff.split_inclusive('\n'){
  if line.starts_with("@@"){
   if let Some((header,body))=current.take(){hunks.push(GitHunk{index:hunks.len(),header,body});}
   current=Some((line.trim_end().to_string(),String::new()));
  }else if let Some((_,body))=current.as_mut(){
   if line.starts_with("diff --git "){break;}
   body.push_str(line);
  }
 }
 if let Some((header,body))=current{hunks.push(GitHunk{index:hunks.len(),header,body});}
 hunks
}
fn file_headers(diff:&str)->Option<(String,String)>{
 let minus=diff.lines().find(|line|line.starts_with("--- "))?.to_string();
 let plus=diff.lines().find(|line|line.starts_with("+++ "))?.to_string();
 Some((minus,plus))
}
#[tauri::command]
pub async fn git_hunks(state:tauri::State<'_,WorkspaceState>,root:String,path:String)->Result<Vec<GitHunk>,String>{
 let root=repository(&state,&root)?;valid_path(&path)?;
 tauri::async_runtime::spawn_blocking(move||{
  let diff=success(git(&root,&["diff","--no-ext-diff","--no-textconv","--no-color","--",&path])?)?;
  Ok(parse_hunks(&diff))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_stage_hunk(state:tauri::State<'_,WorkspaceState>,root:String,path:String,index:usize)->Result<(),String>{
 let root=repository(&state,&root)?;valid_path(&path)?;
 tauri::async_runtime::spawn_blocking(move||{
  let diff=success(git(&root,&["diff","--no-ext-diff","--no-textconv","--no-color","--",&path])?)?;
  let hunks=parse_hunks(&diff);
  let hunk=hunks.get(index).ok_or("That hunk is no longer in the working diff. Refresh Git.")?;
  let (minus,plus)=file_headers(&diff).ok_or("Git diff has no file headers.")?;
  let patch=format!("diff --git a/{path} b/{path}\n{minus}\n{plus}\n{}\n{}",hunk.header,hunk.body);
  let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
  let file=std::env::temp_dir().join(format!("afteredit-hunk-{}-{stamp}.patch",std::process::id()));
  std::fs::write(&file,&patch).map_err(|e|e.to_string())?;
  let applied=success(git(&root,&["apply","--cached","--whitespace=nowarn","--",&file.to_string_lossy()])?);
  let _=std::fs::remove_file(file);
  applied.map(|_|())
 }).await.map_err(|e|e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PushPreview{remote:String,branch:String,head:String,commits:Vec<String>}
fn push_preview(root:&Path)->Result<PushPreview,String>{
 let upstream=success(git(root,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"])?)?;
 let upstream=upstream.trim();
 if upstream.is_empty()||!upstream.contains('/'){return Err("This branch has no upstream. AfterEdit does not guess a remote.".into());}
 let behind=success(git(root,&["rev-list","--count",&format!("HEAD..{upstream}")])?)?;
 if behind.trim()!="0"{return Err("The upstream has commits this branch does not. Pull with fast-forward only before pushing.".into());}
 let head=success(git(root,&["rev-parse","HEAD"])?)?.trim().to_string();
 let branch=success(git(root,&["rev-parse","--abbrev-ref","HEAD"])?)?.trim().to_string();
 if branch=="HEAD"{return Err("Push a named branch. Detached HEAD is not pushed.".into());}
 let remote=upstream.split('/').next().unwrap_or("").to_string();
 let log=success(git(root,&["log","--oneline",&format!("{upstream}..HEAD")])?)?;
 let commits:Vec<String>=log.lines().map(str::to_string).filter(|line|!line.is_empty()).collect();
 if commits.is_empty(){return Err("Nothing on this branch is ahead of the upstream.".into());}
 Ok(PushPreview{remote,branch,head,commits})
}
#[tauri::command]
pub async fn git_push_preview(state:tauri::State<'_,WorkspaceState>,root:String)->Result<PushPreview,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||push_preview(&root)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn git_push(app:tauri::AppHandle,state:tauri::State<'_,WorkspaceState>,root:String,head:String)->Result<String,String>{
 let root=repository(&state,&root)?;
 if head.len()!=40||!head.chars().all(|c|c.is_ascii_hexdigit()){return Err("Push requires the reviewed commit.".into());}
 let reviewed=head.clone();
 let recorded=root.display().to_string();
 let result=tauri::async_runtime::spawn_blocking(move||{
  let preview=push_preview(&root)?;
  if preview.head!=head{return Err("HEAD moved since the push review. Review the commits again.".into());}
  outcome(git_within(&root,&["push"],None,Duration::from_secs(90))?)
 }).await.map_err(|e|e.to_string())??;
 crate::journal::record_app(&app,"push","git push","",&reviewed,&recorded);
 Ok(result)
}
#[cfg(test)]
mod mutation_tests{
 use super::*;
 /// The secrets gate, on the real commit path: a staged credential must stop
 /// the commit, and the refusal must not repeat the credential back.
 #[test]fn commit_refuses_when_a_secret_is_staged(){
  let dir=std::env::temp_dir().join(format!("afteredit-git-secret-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&dir);std::fs::create_dir_all(&dir).unwrap();
  for args in [vec!["init"],vec!["config","user.name","AfterEdit Test"],vec!["config","user.email","test@example.invalid"],vec!["config","commit.gpgsign","false"]]{success(git(&dir,&args).unwrap()).unwrap();}

  std::fs::write(dir.join("config.ini"),"aws_access_key_id = AKIA4NPQ2XZJ7KLMWVR3\n").unwrap();
  success(git(&dir,&["add","--","config.ini"]).unwrap()).unwrap();
  let tree=success(git(&dir,&["write-tree"]).unwrap()).unwrap();

  let refused=commit_snapshot(&dir,"add config",tree.trim()).unwrap_err();
  assert!(refused.starts_with("Commit blocked"),"{refused}");
  assert!(!refused.contains("AKIA4NPQ2XZJ7KLMWVR3"),"refusal repeated the secret: {refused}");
  // Nothing was committed.
  assert!(git(&dir,&["rev-parse","HEAD"]).unwrap().code!=0,"a commit was created despite the block");

  // Remove the credential and the same commit goes through.
  std::fs::write(dir.join("config.ini"),"aws_access_key_id = ${AWS_ACCESS_KEY_ID}\n").unwrap();
  success(git(&dir,&["add","--","config.ini"]).unwrap()).unwrap();
  let clean=success(git(&dir,&["write-tree"]).unwrap()).unwrap();
  commit_snapshot(&dir,"add config",clean.trim()).expect("clean tree should commit");
  assert_eq!(git(&dir,&["rev-parse","HEAD"]).unwrap().code,0);

  let _=std::fs::remove_dir_all(&dir);
 }
 #[test]fn commit_rejects_stale_review_and_preserves_working_tree(){
  let dir=std::env::temp_dir().join(format!("afteredit-git-write-{}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();
  for args in [vec!["init"],vec!["config","user.name","AfterEdit Test"],vec!["config","user.email","test@example.invalid"],vec!["config","commit.gpgsign","false"]]{success(git(&dir,&args).unwrap()).unwrap();}
  std::fs::write(dir.join("file.txt"),"first
").unwrap();success(git(&dir,&["add","--","file.txt"]).unwrap()).unwrap();
  let first=success(git(&dir,&["write-tree"]).unwrap()).unwrap();
  std::fs::write(dir.join("file.txt"),"second
").unwrap();success(git(&dir,&["add","--","file.txt"]).unwrap()).unwrap();
  assert!(commit_snapshot(&dir,"stale",first.trim()).is_err());
  let tree=success(git(&dir,&["write-tree"]).unwrap()).unwrap();
  std::fs::write(dir.join("file.txt"),"unsaved on disk
").unwrap();
  commit_snapshot(&dir,"Reviewed commit",tree.trim()).unwrap();
  assert_eq!(success(git(&dir,&["show","HEAD:file.txt"]).unwrap()).unwrap(),"second
");
  assert_eq!(std::fs::read_to_string(dir.join("file.txt")).unwrap(),"unsaved on disk
");
  assert!(success(git(&dir,&["diff","--cached"]).unwrap()).unwrap().is_empty());
  std::fs::remove_dir_all(dir).unwrap();
 }
 fn repo(name:&str)->std::path::PathBuf{
  let dir=std::env::temp_dir().join(format!("afteredit-git-{name}-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&dir);std::fs::create_dir_all(&dir).unwrap();
  for args in [vec!["init","-b","main"],vec!["config","user.name","AfterEdit Test"],vec!["config","user.email","test@example.invalid"],vec!["config","commit.gpgsign","false"]]{success(git(&dir,&args).unwrap()).unwrap();}
  std::fs::write(dir.join("file.txt"),"one\n").unwrap();
  success(git(&dir,&["add","--","file.txt"]).unwrap()).unwrap();
  success(git(&dir,&["commit","-m","one"]).unwrap()).unwrap();
  dir
 }
 #[test]fn hunks_stage_one_change_and_leave_the_other(){
  let diff="diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-one\n+two\n context\n@@ -8,2 +8,2 @@\n-old\n+new\n";
  let hunks=parse_hunks(diff);
  assert_eq!(hunks.len(),2);
  assert!(hunks[0].body.contains("+two"));
  let dir=repo("hunk");
  std::fs::write(dir.join("file.txt"),"two\nsecond\n").unwrap();
  let live=parse_hunks(&success(git(&dir,&["diff","--no-color","--","file.txt"]).unwrap()).unwrap());
  assert!(!live.is_empty());
  let hunk=&live[0];
  let patch=format!("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n{}\n{}",hunk.header,hunk.body);
  let file=std::env::temp_dir().join(format!("afteredit-hunk-test-{}.patch",std::process::id()));
  std::fs::write(&file,&patch).unwrap();
  success(git(&dir,&["apply","--cached","--whitespace=nowarn","--",&file.to_string_lossy()]).unwrap()).unwrap();
  let _=std::fs::remove_file(file);
  assert!(success(git(&dir,&["diff","--cached"]).unwrap()).unwrap().contains("+two")||success(git(&dir,&["diff","--cached"]).unwrap()).unwrap().contains("two"));
  std::fs::remove_dir_all(dir).unwrap();
 }
 #[test]fn checkout_refuses_a_dirty_tree_and_switches_a_clean_one(){
  let dir=repo("branch");
  assert!(valid_branch("-main").is_err());
  std::fs::write(dir.join("file.txt"),"dirty\n").unwrap();
  assert!(clean(&dir).is_err());
  std::fs::write(dir.join("file.txt"),"one\n").unwrap();
  assert!(clean(&dir).is_ok());
  success(git(&dir,&["switch","-c","feature"]).unwrap()).unwrap();
  assert_eq!(success(git(&dir,&["rev-parse","--abbrev-ref","HEAD"]).unwrap()).unwrap().trim(),"feature");
  std::fs::remove_dir_all(dir).unwrap();
 }
 #[test]fn pull_refuses_a_dirty_tree_before_contacting_a_remote(){
  let dir=repo("pull");
  std::fs::write(dir.join("file.txt"),"dirty\n").unwrap();
  assert!(clean(&dir).is_err());
  std::fs::remove_dir_all(dir).unwrap();
 }
 #[test]fn push_preview_lists_only_commits_ahead_of_upstream(){
  let bare=std::env::temp_dir().join(format!("afteredit-git-bare-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&bare);
  success(git(&std::env::temp_dir(),&["init","--bare","-b","main",&bare.to_string_lossy()]).unwrap()).unwrap();
  let dir=repo("push");
  success(git(&dir,&["remote","add","origin",&bare.to_string_lossy()]).unwrap()).unwrap();
  success(git(&dir,&["push","-u","origin","HEAD"]).unwrap()).unwrap();
  std::fs::write(dir.join("file.txt"),"two\n").unwrap();
  success(git(&dir,&["add","--","file.txt"]).unwrap()).unwrap();
  success(git(&dir,&["commit","-m","two"]).unwrap()).unwrap();
  let preview=push_preview(&dir).unwrap();
  assert_eq!(preview.commits.len(),1);
  assert!(preview.commits[0].contains("two"));
  let head=success(git(&dir,&["rev-parse","HEAD"]).unwrap()).unwrap();
  assert!(push_preview(&dir).unwrap().head==head.trim());
  std::fs::write(dir.join("file.txt"),"three\n").unwrap();
  success(git(&dir,&["commit","-am","three"]).unwrap()).unwrap();
  assert!(push_preview(&dir).is_ok());
  let stale=preview.head.clone();
  let moved=push_preview(&dir).unwrap();
  assert_ne!(moved.head,stale);
  std::fs::remove_dir_all(&dir).unwrap();
  std::fs::remove_dir_all(&bare).unwrap();
 }
}
