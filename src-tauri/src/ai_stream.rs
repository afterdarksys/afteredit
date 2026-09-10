#[derive(Default)]
pub(crate) struct StreamDecoder {
    pending:Vec<u8>,
    data:Vec<String>,
    pub done:bool,
}
impl StreamDecoder {
    pub fn push(&mut self,bytes:&[u8],protocol:&str)->Result<Vec<String>,String>{
        self.pending.extend_from_slice(bytes);
        if self.pending.len()>2_000_000{return Err("AI stream frame exceeds 2 MB".into());}
        let mut deltas=Vec::new();
        while let Some(end)=self.pending.iter().position(|b|*b==b'\n') {
            let row:Vec<_>=self.pending.drain(..=end).collect();
            let line=std::str::from_utf8(&row).map_err(|_|"Provider sent invalid UTF-8")?.trim_end_matches(['\r','\n']);
            if line.is_empty() {if let Some(delta)=self.event(protocol)?{deltas.push(delta);}}
            else if let Some(value)=line.strip_prefix("data:"){self.data.push(value.strip_prefix(' ').unwrap_or(value).into());}
        }
        Ok(deltas)
    }
    fn event(&mut self,protocol:&str)->Result<Option<String>,String>{
        if self.data.is_empty() || self.done {self.data.clear();return Ok(None);}
        let data=self.data.join("\n");self.data.clear();
        if data=="[DONE]" {self.done=true;return Ok(None);}
        let json:serde_json::Value=serde_json::from_str(&data).map_err(|_|"Provider sent invalid stream JSON")?;
        if json.get("error").is_some() || json["type"]=="error"{return Err("Provider reported an error during streaming; reservation retained.".into());}
        let delta=if protocol=="anthropic"{
            if json["type"]=="message_stop"{self.done=true;}
            if json["type"]=="content_block_delta" && json["delta"]["type"]=="text_delta"{json["delta"]["text"].as_str()}
            else if json["type"]=="content_block_start"{json["content_block"]["text"].as_str()}else{None}
        }else{json.pointer("/choices/0/delta/content").and_then(|v|v.as_str())};
        Ok(delta.filter(|s|!s.is_empty()).map(str::to_string))
    }
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn handles_split_unicode_crlf_and_terminal_events(){
  let bytes="data: {\"choices\":[{\"delta\":{\"content\":\"héllo\"}}]}\r\n\r\ndata: [DONE]\n\n".as_bytes();
  let mut parser=StreamDecoder::default();let mut text=String::new();
  for b in bytes {for delta in parser.push(&[*b],"openai").unwrap(){text.push_str(&delta);}}
  assert_eq!(text,"héllo");assert!(parser.done);
 }
 #[test]fn anthropic_errors_and_incomplete_streams_are_distinct(){
  let mut parser=StreamDecoder::default();
  assert_eq!(parser.push(b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n","anthropic").unwrap(),vec!["hello"]);
  assert!(!parser.done);
  parser.push(b"data: {\"type\":\"message_stop\"}\n\n","anthropic").unwrap();assert!(parser.done);
  assert!(StreamDecoder::default().push(b"data: {\"type\":\"error\",\"error\":{}}\n\n","anthropic").is_err());
 }
}
