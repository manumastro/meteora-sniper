const dns = require('dns');

const domain = 'quote-api.jup.ag';
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);

resolver.resolve4(domain, (err, addresses) => {
  if (err) {
    console.error('DNS Error:', err);
    return;
  }
  console.log('IP Addresses:', addresses);
});
