use base64::{engine::general_purpose::STANDARD, Engine};
use std::time::Duration;
async fn get(url: reqwest::Url, limit: usize) -> Result<Vec<u8>,String> {
 let client=reqwest::Client::builder().timeout(Duration::from_secs(45)).redirect(reqwest::redirect::Policy::custom(|attempt| {
   if attempt.previous().len()<4 && attempt.url().scheme()=="https" && matches!(attempt.url().host_str(),Some("open-vsx.org" | "storage.googleapis.com")) { attempt.follow() } else { attempt.stop() }
 })).build().map_err(|e|e.to_string())?;
 let mut response=client.get(url).send().await.map_err(|e|e.to_string())?;
 if !response.status().is_success() {return Err(format!("Registry returned HTTP {}",response.status()));}
 let mut bytes=Vec::new();
 while let Some(chunk)=response.chunk().await.map_err(|e|e.to_string())? {if bytes.len()+chunk.len()>limit{return Err("Registry response exceeds size limit".into());}bytes.extend_from_slice(&chunk);}
 Ok(bytes)
}
#[tauri::command]
pub async fn registry_search(query:String)->Result<serde_json::Value,String>{
 let mut url=reqwest::Url::parse("https://open-vsx.org/api/-/search").unwrap();
 url.query_pairs_mut().append_pair("query",&query).append_pair("size","20");
 serde_json::from_slice(&get(url,2_000_000).await?).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn registry_download(namespace:String,name:String)->Result<String,String>{
 for segment in [&namespace,&name] {if segment.is_empty() || segment.len()>128 || !segment.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){return Err("Invalid registry identifier".into());}}
 let url=reqwest::Url::parse(&format!("https://open-vsx.org/api/{namespace}/{name}/latest")).map_err(|e|e.to_string())?;
 let metadata:serde_json::Value=serde_json::from_slice(&get(url,2_000_000).await?).map_err(|e|e.to_string())?;
 let url=reqwest::Url::parse(metadata.pointer("/files/download").and_then(|v|v.as_str()).ok_or("Registry omitted download URL")?).map_err(|e|e.to_string())?;
 if url.scheme()!="https" || url.host_str()!=Some("open-vsx.org") {return Err("Unrecognized registry download origin".into());}
 Ok(STANDARD.encode(get(url,20*1024*1024).await?))
}
