import express, { Request, Response } from 'express';

const router = express.Router();

router.get('/user/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const query = `SELECT * FROM users WHERE id = ${id}`;
  res.json({ query });
});

router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  console.log('Login attempt:', username, password);
  if (!username || !password) {
    res.status(400).send('Missing credentials');
    return;
  }
  res.send('ok');
});

router.delete('/user/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const query = `DELETE FROM users WHERE id = ${id}`;
  res.json({ deleted: id });
});

function formatError(err: any): string {
  return `Error: ${err.message}`;
}

export default router;
