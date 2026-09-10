use serde::Serialize;
use std::{process::Command,time::Duration};
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ToolInfo {name:String,available:bool,path:Option<String>,version:String}
fn probe(name:&str)->ToolInfo {
 let executable=if name=="ansibug"{"python3"}else{name};
 let Some(path)=crate::lsp_installer::resolve_binary(executable) else{return ToolInfo{name:name.into(),available:false,path:None,version:format!("{executable} was not found on the application PATH.")};};
 let mut command=Command::new(&path);
 command.current_dir(std::env::temp_dir());
 if let Ok(path)=std::env::join_paths(crate::lsp_installer::search_dirs()){command.env("PATH",path);}
 if name=="ansibug"{command.args(["-I","-c","import importlib.metadata; print(importlib.metadata.version('ansibug'))"]);}else{command.arg("--version");}
 match crate::process::run(command,Duration::from_secs(5)){
  Ok(output) if output.code==0=>ToolInfo{name:name.into(),available:true,path:Some(path.to_string_lossy().into()),version:output.stdout.lines().take(3).collect::<Vec<_>>().join("\n")},
  Ok(output)=>ToolInfo{name:name.into(),available:false,path:Some(path.to_string_lossy().into()),version:format!("Version check failed: {}",output.stderr.chars().take(500).collect::<String>())},
  Err(error)=>ToolInfo{name:name.into(),available:false,path:Some(path.to_string_lossy().into()),version:error},
 }
}
#[tauri::command]
pub async fn inspect_tools(names:Vec<String>)->Result<Vec<ToolInfo>,String>{
 if names.len()>8 || names.iter().any(|name|!["terraform","tofu","ansible-playbook","ansible-lint","tflint","ansibug","python3","git"].contains(&name.as_str())){return Err("Unsupported tool check".into());}
 tauri::async_runtime::spawn_blocking(move||names.iter().map(|name|probe(name)).collect()).await.map_err(|e|e.to_string())
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn installed_git_is_detected_without_a_project(){let result=probe("git");assert!(result.available,"{}",result.version);assert!(result.version.contains("git version"));}
}
