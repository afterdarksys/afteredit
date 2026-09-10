use crate::{process::{run,Output},workspace::{allowed,WorkspaceState}};
use serde::Serialize;
use std::{path::{Component,Path,PathBuf},process::Command,time::Duration};
#[derive(Clone,Serialize,Debug)]
#[serde(rename_all="camelCase")]
pub struct GitFile {pub path:String,pub original_path:Option<String>,pub index:String,pub worktree:String}
#[derive(Serialize)]
pub struct GitStatus {branch:String,files:Vec<GitFile>}
fn git(root:&Path,args:&[&str])->Result<Output,String>{git_index(root,args,None)}
fn git_index(root:&Path,args:&[&str],index:Option<&Path>)->Result<Output,String>{
    let binary=crate::toolpath::resolve_binary("git").ok_or("Git was not found. Install Git and reopen AfterEdit.")?;
    let mut command=Command::new(binary);
    command.current_dir(root).args(["--no-pager","--literal-pathspecs"]).args(args);
    for (key,_) in std::env::vars_os(){if key.to_string_lossy().starts_with("GIT_"){command.env_remove(key);}}
    if let Some(index)=index{command.env("GIT_INDEX_FILE",index);}
    command.env("GIT_TERMINAL_PROMPT","0").env("GIT_OPTIONAL_LOCKS","0").env("LC_ALL","C");
    run(command,Duration::from_secs(30))
}
fn success(output:Output)->Result<String,String>{
    if output.code==0 {Ok(output.stdout)}else{Err(format!("Git exited {}: {}",output.code,output.stderr))}
}
fn repository(state:&WorkspaceState,root:&str)->Result<PathBuf,String>{
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
pub async fn git_commit(state:tauri::State<'_,WorkspaceState>,root:String,message:String,tree:String)->Result<String,String>{
 let root=repository(&state,&root)?;
 tauri::async_runtime::spawn_blocking(move||commit_snapshot(&root,&message,&tree)).await.map_err(|e|e.to_string())?
}
#[cfg(test)]
mod mutation_tests{
 use super::*;
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
}
