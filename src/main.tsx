import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './ErrorBoundary';
import StartupRecovery from './StartupRecovery';
import './App.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
if(new URLSearchParams(location.search).get('safe')==='1'){
  root.render(<StartupRecovery/>);
}else{
  root.render(<div className="recovery" role="status">Starting AfterEdit… <a href="?safe=1">Open recovery editor</a></div>);
  let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Startup did not finish within 20 seconds. Use recovery mode or retry.')),20000);});
  Promise.race([import('./App'),timeout]).then(({default:App})=>{
    root.render(<React.StrictMode><ErrorBoundary fallback={<StartupRecovery/>}><App/></ErrorBoundary></React.StrictMode>);
  }).catch(error=>root.render(<StartupRecovery error={String(error)}/>)).finally(()=>clearTimeout(timer));
}
