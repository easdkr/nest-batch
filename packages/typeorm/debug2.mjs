// Bypass the vitest config and just check imports
process.chdir('/Users/june/workspace/personal/nest-batch/packages/typeorm');

(async () => {
  // Simulate what vitest does
  const typeorm = await import('typeorm');
  console.log('Entity:', typeorm.Entity);
  console.log('PrimaryColumn:', typeorm.PrimaryColumn);
  console.log('Column:', typeorm.Column);
  console.log('Index:', typeorm.Index);
})();
