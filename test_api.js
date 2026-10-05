const http = require('http');

http.get('http://localhost:8081/OpentelemetryService/api/logs?page=0&size=50', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const logs = JSON.parse(data);
      console.log(`Fetched ${logs.length} logs from backend without serviceName filter.`);
      const counts = {};
      logs.forEach(log => {
        const s = log["service.name"] || log.serviceName || "none";
        counts[s] = (counts[s] || 0) + 1;
      });
      console.log("Service distribution in Top 50:", counts);
      
      const first10 = logs.slice(0, 10);
      const top10counts = {};
      first10.forEach(log => {
        const s = log["service.name"] || log.serviceName || "none";
        top10counts[s] = (top10counts[s] || 0) + 1;
      });
      console.log("Service distribution in Top 10:", top10counts);
    } catch (e) {
      console.error("JSON parse error:", e);
    }
  });
}).on('error', err => {
  console.log('HTTP GET Error: ', err.message);
});
