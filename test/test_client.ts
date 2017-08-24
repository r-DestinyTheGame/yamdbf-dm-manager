import { Client, Logger } from 'yamdbf';
import { dmManager } from '../bin/';
const { token, owner, guild } = require('./config.json');
const logger: Logger = Logger.instance();

class Test extends Client
{
	public constructor()
	{
		super({
			token: token,
			owner: owner,
			readyText: 'Test client ready',
			plugins: [dmManager(guild)]
		});
	}
}

const test: Test = new Test();
test.start();

process.on('unhandledRejection', (err: any) => logger.error('UnhandledRejection', err.stack));
