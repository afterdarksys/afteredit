//! Apple development commands use the selected Xcode installation and authorized roots.
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},process::Command,time::Duration};
fn mac()->Result<(),String>{if cfg!(target_os="macos"){Ok(())}else{Err("Apple development tools require macOS and Xcode.".into())}}
fn run(root:&Path,program:&str,args:&[&str])->Result<String,String>{
 mac()?;let mut command=Command::new(program);command.current_dir(root).args(args);
 let output=crate::process::run(command,Duration::from_secs(90))?;
 if output.code!=0{return Err(format!("{program} exited {}: {}",output.code,output.stderr.chars().take(4000).collect::<String>()));}Ok(output.stdout)
}
#[tauri::command]
pub async fn apple_toolchain()->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(||{
  mac()?;let root=std::env::temp_dir();let mut checks=Vec::new();
  for (name,program,args) in [
   ("Developer directory","/usr/bin/xcode-select",vec!["-p"]),
   ("Xcode","/usr/bin/xcodebuild",vec!["-version"]),
   ("Swift","/usr/bin/xcrun",vec!["swift","--version"]),
   ("SourceKit-LSP","/usr/bin/xcrun",vec!["--find","sourcekit-lsp"]),
   ("LLDB","/usr/bin/xcrun",vec!["--find","lldb-dap"]),
   ("Simulator tools","/usr/bin/xcrun",vec!["--find","simctl"]),
   ("Device tools","/usr/bin/xcrun",vec!["--find","devicectl"]),
  ] {match run(&root,program,&args){Ok(detail)=>checks.push(json!({"name":name,"available":true,"detail":detail.trim()})),Err(detail)=>checks.push(json!({"name":name,"available":false,"detail":detail}))}}
  Ok(json!(checks))
 }).await.map_err(|e|e.to_string())?
}
fn scan(root:&Path)->Result<Vec<String>,String>{
 fn walk(root:&Path,path:&Path,depth:usize,count:&mut usize,found:&mut Vec<String>)->Result<(),String>{
  for entry in std::fs::read_dir(path).map_err(|e|e.to_string())?{
   let entry=entry.map_err(|e|e.to_string())?;*count+=1;if *count>5000{return Err("Project scan exceeds 5,000 entries. Open a narrower folder.".into());}
   let kind=entry.file_type().map_err(|e|e.to_string())?;if kind.is_symlink(){continue;}let name=entry.file_name().to_string_lossy().into_owned();let p=entry.path();
   if (kind.is_dir()&&(name.ends_with(".xcodeproj")||name.ends_with(".xcworkspace")))||(kind.is_file()&&name=="Package.swift") {found.push(p.strip_prefix(root).unwrap().to_string_lossy().into());continue;}
   if kind.is_dir()&&depth<4&&!name.starts_with('.')&&!matches!(name.as_str(),"node_modules"|"Pods"|"build"|"DerivedData"|"target")&&!name.ends_with(".app") {walk(root,&p,depth+1,count,found)?;}
  }Ok(())
 }
 let mut found=vec![];walk(root,root,0,&mut 0,&mut found)?;found.sort();Ok(found)
}
#[tauri::command]
pub async fn apple_projects(workspace:tauri::State<'_,crate::workspace::WorkspaceState>,root:String)->Result<Vec<String>,String>{
 let root=crate::workspace::allowed(&workspace,Path::new(&root))?;
 tauri::async_runtime::spawn_blocking(move||scan(&root)).await.map_err(|e|e.to_string())?
}
fn within(root:&Path,path:&str)->Result<PathBuf,String>{
 if path.is_empty()||Path::new(path).is_absolute()||Path::new(path).components().any(|c|!matches!(c,std::path::Component::Normal(_))){return Err("Choose a relative path inside the project.".into());}
 let p=root.join(path).canonicalize().map_err(|e|e.to_string())?;
 if !p.starts_with(root){return Err("Path escapes the selected project.".into());}Ok(p)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn finds_packages_and_projects_without_descending_into_bundles(){
  let root=std::env::temp_dir().join(format!("afteredit-apple-scan-{}",std::process::id()));let _=std::fs::remove_dir_all(&root);std::fs::create_dir_all(root.join("App.xcodeproj/project.xcworkspace")).unwrap();std::fs::create_dir_all(root.join("Library")).unwrap();std::fs::write(root.join("Library/Package.swift"),"").unwrap();
  assert_eq!(scan(&root).unwrap(),vec!["App.xcodeproj","Library/Package.swift"]);assert!(within(&root,"../outside").is_err());std::fs::remove_dir_all(root).unwrap();
 }
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Query {kind:String,#[serde(default)]project:String,#[serde(default)]scheme:String,#[serde(default)]target:String,#[serde(default)]configuration:String,#[serde(default)]path:String,#[serde(default)]destination:String}
fn value(value:&str)->Result<(),String>{if value.len()>1000||value.starts_with('-')||value.contains(['\0','\n','\r']){Err("Invalid Apple tool argument.".into())}else{Ok(())}}
fn query(root:&Path,q:Query)->Result<String,String>{
 for v in [&q.scheme,&q.target,&q.configuration,&q.destination]{value(v)?;}
 if q.kind=="results"{let path=within(root,&q.path)?;if path.extension().and_then(|v|v.to_str())!=Some("xcresult"){return Err("Select an xcresult bundle.".into());}return run(root,"/usr/bin/xcrun",&["xcresulttool","get","test-results","summary","--path",&path.to_string_lossy(),"--compact"]);}
 if q.kind=="simulators"{return run(root,"/usr/bin/xcrun",&["simctl","list","devices","--json"]);}
 if q.kind=="devices"{
  static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
  let directory=std::env::temp_dir().join(format!("afteredit-devices-{}-{}",std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));
  std::fs::create_dir(&directory).map_err(|e|e.to_string())?;
  struct Cleanup(PathBuf);impl Drop for Cleanup{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
  let _cleanup=Cleanup(directory.clone());let path=directory.join("devices.json");
  run(root,"/usr/bin/xcrun",&["devicectl","list","devices","--timeout","30","--json-output",&path.to_string_lossy()])?;
  if std::fs::metadata(&path).map_err(|e|e.to_string())?.len()>2_000_000{return Err("Device report exceeds 2 MB.".into());}
  return std::fs::read_to_string(path).map_err(|e|e.to_string());
 }
 let project=within(root,&q.project)?;
 if project.file_name().and_then(|v|v.to_str())==Some("Package.swift") {
  if q.kind!="metadata"{return Err("Swift packages use Swift build/test commands, not Xcode destinations.".into());}
  return run(project.parent().unwrap(),"/usr/bin/xcrun",&["swift","package","describe","--type","json"]);
 }
 let kind=match project.extension().and_then(|v|v.to_str()){Some("xcodeproj")=>"-project",Some("xcworkspace")=>"-workspace",_=>return Err("Choose an Xcode project, workspace or Package.swift.".into())};
 let mut args=vec![kind.to_string(),project.to_string_lossy().into_owned()];
 match q.kind.as_str(){"metadata"=>args.extend(["-list".into(),"-json".into()]),"destinations"|"settings"=>{
  if q.scheme.is_empty()&&q.target.is_empty(){return Err("Select a scheme or target first.".into());}
  if !q.scheme.is_empty(){args.extend(["-scheme".into(),q.scheme.clone()]);}else{args.extend(["-target".into(),q.target]);}
  if !q.configuration.is_empty(){args.extend(["-configuration".into(),q.configuration]);}
  if q.kind=="settings"{if !q.destination.is_empty(){args.extend(["-destination".into(),q.destination]);}if !q.scheme.is_empty(){args.extend(["-derivedDataPath".into(),root.join(".afteredit/apple/DerivedData").to_string_lossy().into()]);}else{args.extend([format!("SYMROOT={}",root.join(".afteredit/apple/Products").display()),format!("OBJROOT={}",root.join(".afteredit/apple/Intermediates").display())]);}}
  if q.kind=="destinations"{args.push("-showdestinations".into());}else{args.extend(["-showBuildSettings".into(),"-json".into()]);}
 },_=>return Err("Unsupported Apple query.".into())}
 run(root,"/usr/bin/xcodebuild",&args.iter().map(String::as_str).collect::<Vec<_>>())
}
#[tauri::command]
pub async fn apple_query(workspace:tauri::State<'_,crate::workspace::WorkspaceState>,root:String,query:Query)->Result<String,String>{
 let root=crate::workspace::allowed(&workspace,Path::new(&root))?;
 tauri::async_runtime::spawn_blocking(move||self::query(&root,query)).await.map_err(|e|e.to_string())?
}
