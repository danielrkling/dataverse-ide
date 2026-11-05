async function r(a,e){try{return await a.workspace.fs.stat(e),!1}catch{}return await a.workspace.fs.createDirectory(e),!0}export{r as e};
